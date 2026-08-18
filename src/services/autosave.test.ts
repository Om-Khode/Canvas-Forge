import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS } from '@/constants/storage';
import type { SaveStatus } from '@/types';
import { createAutosaveScheduler, type AutosaveScheduler } from './autosave';
import { err, ok, type Result } from './result';

interface Harness {
  scheduler: AutosaveScheduler;
  statuses: SaveStatus[];
  saves: () => number;
  fail: (message: string | null) => void;
  errors: string[];
}

function harness(): Harness {
  const statuses: SaveStatus[] = [];
  const errors: string[] = [];
  let count = 0;
  let failure: string | null = null;

  const scheduler = createAutosaveScheduler<string>({
    save: (): Promise<Result<void, string>> => {
      count++;
      return Promise.resolve(failure === null ? ok(undefined) : err(failure));
    },
    onStatusChange: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });

  return {
    scheduler,
    statuses,
    errors,
    saves: () => count,
    fail: (message) => {
      failure = message;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('does not write before the debounce elapses', async () => {
    const h = harness();
    h.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(h.saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saves()).toBe(1);
  });

  it('coalesces a burst of edits into a single write', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      h.scheduler.schedule();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(h.saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.saves()).toBe(1);
  });

  it('reports unsaved → saving → saved', async () => {
    const h = harness();
    expect(h.scheduler.getStatus()).toBe('saved');
    h.scheduler.schedule();
    expect(h.scheduler.getStatus()).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.statuses).toEqual(['unsaved', 'saving', 'saved']);
    expect(h.scheduler.isDirty()).toBe(false);
  });
});

describe('blocking', () => {
  it('does not write while a transaction is open', async () => {
    const h = harness();
    h.scheduler.setBlocked(true);
    h.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 5);
    expect(h.saves()).toBe(0);
    expect(h.scheduler.getStatus()).toBe('unsaved');
  });

  it('writes once the transaction commits and the debounce elapses again', async () => {
    const h = harness();
    h.scheduler.setBlocked(true);
    h.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    h.scheduler.setBlocked(false);
    expect(h.saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.saves()).toBe(1);
  });

  it('lets an explicit flush through even while blocked', async () => {
    const h = harness();
    h.scheduler.setBlocked(true);
    h.scheduler.schedule();
    await h.scheduler.flush();
    expect(h.saves()).toBe(1);
    expect(h.scheduler.getStatus()).toBe('saved');
  });
});

describe('flush and cancel', () => {
  it('flush is a no-op when nothing is pending', async () => {
    const h = harness();
    await h.scheduler.flush();
    expect(h.saves()).toBe(0);
  });

  it('cancel drops the pending write', async () => {
    const h = harness();
    h.scheduler.schedule();
    h.scheduler.cancel();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.saves()).toBe(0);
    expect(h.scheduler.getStatus()).toBe('saved');
  });

  it('dispose stops any further writes', async () => {
    const h = harness();
    h.scheduler.schedule();
    h.scheduler.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(h.saves()).toBe(0);
  });
});

describe('failure', () => {
  it('surfaces an error status and keeps the document dirty', async () => {
    const h = harness();
    h.fail('quota exceeded');
    h.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(h.scheduler.getStatus()).toBe('error');
    expect(h.scheduler.isDirty()).toBe(true);
    expect(h.errors).toEqual(['quota exceeded']);
  });

  it('recovers on the next successful write', async () => {
    const h = harness();
    h.fail('disk full');
    h.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.scheduler.getStatus()).toBe('error');

    h.fail(null);
    await h.scheduler.flush();
    expect(h.scheduler.getStatus()).toBe('saved');
    expect(h.saves()).toBe(2);
  });
});
