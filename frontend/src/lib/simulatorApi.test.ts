import { describe, expect, it, vi } from 'vitest';

import { SimulatorApiClient, type BackendFetch, type BackendResponse } from './simulatorApi';

function jsonResponse(status: number, body: unknown): BackendResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('SimulatorApiClient', () => {
  it('starts a scenario via POST /api/simulator/start and returns the run result', async () => {
    const fetchFn = vi.fn<BackendFetch>(async () =>
      jsonResponse(200, { started: true, scenario: 'sui-flash-crash', result: { scenarioId: 'sui-flash-crash', title: 'SUI flash crash', status: 'action_executed', steps: [] } }),
    );
    const client = new SimulatorApiClient(fetchFn, 'http://backend');

    const result = await client.start('sui-flash-crash');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.scenarioId).toBe('sui-flash-crash');
    }
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://backend/api/simulator/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ scenario: 'sui-flash-crash' });
  });

  it('surfaces a descriptive error when start is rejected (Req 15.4)', async () => {
    const fetchFn = vi.fn<BackendFetch>(async () =>
      jsonResponse(400, { error: 'invalid_input', field: 'scenario', message: 'unknown scenario' }),
    );
    const client = new SimulatorApiClient(fetchFn);

    const result = await client.start('nope');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('scenario');
      expect(result.message).toBe('unknown scenario');
    }
  });

  it('resets via POST /api/simulator/reset', async () => {
    const fetchFn = vi.fn<BackendFetch>(async () => jsonResponse(200, { reset: true }));
    const client = new SimulatorApiClient(fetchFn);

    const result = await client.reset();

    expect(result.ok).toBe(true);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/simulator/reset');
  });

  it('submits an override via POST /api/actions/override and maps the result', async () => {
    const fetchFn = vi.fn<BackendFetch>(async () =>
      jsonResponse(200, {
        result: { success: true, stage: 'submit', operation: 'reverse_action', txDigest: 'DIG' },
      }),
    );
    const client = new SimulatorApiClient(fetchFn);

    const outcome = await client.override({
      request: { operation: 'reverse_action', reason: 'manual reversal' },
      evaluation: {},
      actionContext: {},
      actionLogId: 'scenario:override',
      record: { policyId: 'p', marketId: 'm', daoAddress: '0xdao' },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.success).toBe(true);
    expect(outcome.txDigest).toBe('DIG');
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/actions/override');
  });

  it('reports a descriptive override error on rejection (Req 11.6, 15.4)', async () => {
    const fetchFn = vi.fn<BackendFetch>(async () =>
      jsonResponse(400, { error: 'invalid_input', field: 'request.reason', message: 'reason required' }),
    );
    const client = new SimulatorApiClient(fetchFn);

    const outcome = await client.override({
      request: { operation: 'reverse_action', reason: '' },
      evaluation: {},
      actionContext: {},
      actionLogId: 'x',
      record: { policyId: 'p', marketId: 'm', daoAddress: '0xdao' },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.field).toBe('request.reason');
    expect(outcome.message).toBe('reason required');
  });
});
