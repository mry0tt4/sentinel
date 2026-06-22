// Extends Vitest's `expect` with Testing Library's DOM matchers
// (e.g. `toBeInTheDocument`, `toHaveTextContent`). Registered explicitly via
// `expect.extend` so it works across Vitest 4 (the `/vitest` auto-extend entry
// is version-sensitive; the explicit form is stable).
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import type { ReactElement } from 'react';
import { expect, vi } from 'vitest';

expect.extend(jestDomMatchers);

// ---------------------------------------------------------------------------
// jsdom layout shims for Recharts.
//
// Recharts' <ResponsiveContainer> measures its parent via ResizeObserver, which
// jsdom can't drive, so it renders charts at 0×0 and logs "The width(0) and
// height(0) of chart should be greater than 0". We mock ResponsiveContainer to
// clone its chart child with a fixed test size. Cosmetic-only; the charts under
// test never assert on pixel dimensions.
// ---------------------------------------------------------------------------
const CHART_WIDTH = 800;
const CHART_HEIGHT = 600;

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  const { cloneElement, Children } = await import('react');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(Children.only(children) as ReactElement<Record<string, unknown>>, {
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
      }),
  };
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

for (const [prop, value] of [
  ['offsetWidth', CHART_WIDTH],
  ['offsetHeight', CHART_HEIGHT],
  ['clientWidth', CHART_WIDTH],
  ['clientHeight', CHART_HEIGHT],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return value;
    },
  });
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  const rect = originalGetBoundingClientRect.call(this);
  const width = rect.width || CHART_WIDTH;
  const height = rect.height || CHART_HEIGHT;
  return {
    width,
    height,
    top: rect.top || 0,
    left: rect.left || 0,
    right: rect.right || width,
    bottom: rect.bottom || height,
    x: rect.x || 0,
    y: rect.y || 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
};

// ---------------------------------------------------------------------------
// Default network stub.
//
// Some components (e.g. the dashboard's ReplayPanel) issue a `fetch` on mount.
// Component tests inject their own data clients or override `global.fetch`, so
// the default here is a never-settling promise: incidental on-mount fetches
// stay pending and never trigger a late, un-acted state update. Tests that
// need real responses assign their own `global.fetch` mock, which takes over.
// ---------------------------------------------------------------------------
if (typeof globalThis.fetch === 'undefined' || !('mock' in (globalThis.fetch as object))) {
  globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}
