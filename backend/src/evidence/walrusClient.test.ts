import { describe, expect, it } from 'vitest';

import { HttpWalrusClient, WalrusStoreError, type FetchLike } from './walrusClient.js';

/** Build a fetch double returning the given status + body. */
function fakeFetch(status: number, body: string): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { fn, calls };
}

describe('HttpWalrusClient.store', () => {
  it('PUTs to /v1/blobs and parses a newlyCreated blob id', async () => {
    const { fn, calls } = fakeFetch(
      200,
      JSON.stringify({ newlyCreated: { blobObject: { blobId: 'NEW_BLOB' } } }),
    );
    const client = new HttpWalrusClient({ publisherUrl: 'https://pub.example', fetchFn: fn });

    const result = await client.store(new TextEncoder().encode('{}'));

    expect(result.blobId).toBe('NEW_BLOB');
    expect(calls).toEqual(['https://pub.example/v1/blobs']);
  });

  it('parses an alreadyCertified blob id', async () => {
    const { fn } = fakeFetch(200, JSON.stringify({ alreadyCertified: { blobId: 'OLD_BLOB' } }));
    const client = new HttpWalrusClient({ publisherUrl: 'https://pub.example/', fetchFn: fn });

    const result = await client.store(new TextEncoder().encode('{}'));
    expect(result.blobId).toBe('OLD_BLOB');
  });

  it('throws WalrusStoreError on a non-2xx response', async () => {
    const { fn } = fakeFetch(500, 'boom');
    const client = new HttpWalrusClient({ publisherUrl: 'https://pub.example', fetchFn: fn });

    await expect(client.store(new TextEncoder().encode('{}'))).rejects.toBeInstanceOf(
      WalrusStoreError,
    );
  });

  it('throws WalrusStoreError when the response has no blob id', async () => {
    const { fn } = fakeFetch(200, JSON.stringify({ unexpected: true }));
    const client = new HttpWalrusClient({ publisherUrl: 'https://pub.example', fetchFn: fn });

    await expect(client.store(new TextEncoder().encode('{}'))).rejects.toBeInstanceOf(
      WalrusStoreError,
    );
  });

  it('throws WalrusStoreError when the transport rejects', async () => {
    const fn: FetchLike = async () => {
      throw new Error('network down');
    };
    const client = new HttpWalrusClient({ publisherUrl: 'https://pub.example', fetchFn: fn });

    await expect(client.store(new TextEncoder().encode('{}'))).rejects.toBeInstanceOf(
      WalrusStoreError,
    );
  });

  it('rejects an empty publisher url', () => {
    expect(() => new HttpWalrusClient({ publisherUrl: '   ', fetchFn: async () => ({ ok: true, status: 200, text: async () => '{}' }) })).toThrow();
  });
});
