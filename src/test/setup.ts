import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * jsdom implements neither of these, and both are load-bearing for the editor:
 * the renderer schedules paints on rAF, and every responsive panel - plus the
 * canvas itself - sizes off a ResizeObserver.
 *
 * Stubbed unconditionally rather than behind a feature check: the DOM lib types
 * declare both as always present, so a guard is dead code the compiler can see
 * through, and an unconditional stub keeps every test run identical regardless
 * of what the environment happens to provide.
 */
vi.stubGlobal(
  'matchMedia',
  vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
);

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);
