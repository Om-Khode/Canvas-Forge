import { describe, expect, it } from 'vitest';
import { benchmark, formatResult, percentile, ratio, summarize } from './benchmark';

/**
 * The statistics are asserted against a scripted clock rather than against real
 * timings. A timing helper tested with real timings can only assert "roughly",
 * and "roughly" is exactly the standard that lets an off-by-one percentile
 * index into a document full of quoted numbers.
 */
function scriptedClock(durations: readonly number[]): () => number {
  let time = 0;
  let index = 0;
  let inside = false;
  return () => {
    if (!inside) {
      inside = true;
      return time;
    }
    inside = false;
    time += durations[index++] ?? 0;
    return time;
  };
}

describe('percentile', () => {
  it('uses nearest rank, so every result is a sample that actually occurred', () => {
    const samples = [10, 20, 30, 40];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.75)).toBe(30);
    expect(percentile(samples, 1)).toBe(40);
    expect(percentile(samples, 0)).toBe(10);
  });

  it('does not care what order the samples arrive in', () => {
    expect(percentile([30, 10, 40, 20], 0.5)).toBe(20);
  });

  it('clamps fractions outside [0, 1] rather than indexing off the end', () => {
    expect(percentile([1, 2, 3], 2)).toBe(3);
    expect(percentile([1, 2, 3], -1)).toBe(1);
  });

  it('refuses an empty sample set instead of inventing a number', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });
});

describe('summarize', () => {
  it('reports the distribution, not just a total', () => {
    const result = summarize('op', [4, 1, 3, 2]);
    expect(result.min).toBe(1);
    expect(result.max).toBe(4);
    expect(result.median).toBe(2);
    expect(result.mean).toBe(2.5);
    expect(result.totalMs).toBe(10);
    expect(result.iterations).toBe(4);
  });

  /** The reason this project quotes median and p95 rather than a mean. */
  it('keeps one outlier out of the median while the mean swallows it', () => {
    const samples = [...Array<number>(99).fill(1), 500];
    const result = summarize('gc pause', samples);

    expect(result.median).toBe(1);
    expect(result.p95).toBe(1);
    // The mean claims the typical call costs six times what it does.
    expect(result.mean).toBeCloseTo(5.99, 2);
    expect(result.max).toBe(500);
  });

  it('derives ops/second from the median', () => {
    expect(summarize('op', [2, 2, 2]).opsPerSecond).toBe(500);
  });

  /** Below the clock's resolution, "infinitely fast" is the honest reading. */
  it('reports Infinity rather than a made-up rate when the median rounds to zero', () => {
    expect(summarize('op', [0, 0, 0]).opsPerSecond).toBe(Infinity);
  });
});

describe('benchmark', () => {
  it('times each iteration through the injected clock', () => {
    const result = benchmark('op', () => 1, {
      iterations: 4,
      warmup: 0,
      now: scriptedClock([1, 2, 3, 4]),
    });

    expect(result.iterations).toBe(4);
    expect(result.median).toBe(2);
    expect(result.p95).toBe(4);
  });

  it('runs the warmup but never times it', () => {
    let calls = 0;
    const result = benchmark(
      'op',
      () => {
        calls += 1;
        return calls;
      },
      { iterations: 3, warmup: 5, now: scriptedClock([7, 7, 7]) }
    );

    // Eight calls, three samples: the warmup pays the JIT's compilation cost so
    // the timed run measures compiled code, and contributes nothing to the
    // statistics.
    expect(calls).toBe(8);
    expect(result.iterations).toBe(3);
    expect(result.median).toBe(7);
  });

  it('runs the operation exactly once per iteration', () => {
    let calls = 0;
    benchmark(
      'op',
      () => {
        calls += 1;
      },
      { iterations: 10, warmup: 0, now: () => 0 }
    );
    expect(calls).toBe(10);
  });
});

describe('reporting', () => {
  it('formats one quotable line', () => {
    const line = formatResult(summarize('hit-test @2000', [1, 2, 3, 4]));
    expect(line).toContain('hit-test @2000');
    expect(line).toContain('median 2.000ms');
    expect(line).toContain('p95 4.000ms');
    expect(line).toContain('n=4');
  });

  it('expresses one result as a multiple of another', () => {
    expect(ratio(summarize('big', [10]), summarize('small', [2]))).toBe(5);
  });
});
