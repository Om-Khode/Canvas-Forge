/**
 * Measurement helpers.
 *
 * Small on purpose: the value of a benchmark harness in a project this size is
 * not the harness, it is that the numbers quoted in `docs/performance.md` were
 * produced by something reproducible rather than by a stopwatch and optimism.
 *
 * Two decisions are worth stating.
 *
 * **Median and p95, never mean.** A single GC pause or a scheduler hiccup lands
 * one sample two orders of magnitude above the rest, and a mean over 200
 * samples happily reports that outlier as a third of the "typical" cost. The
 * median says what a normal run costs; p95 says what a bad one costs. Both are
 * facts about the distribution; the mean is a fact about the outlier.
 *
 * **The clock is injectable.** `now` defaults to `performance.now`, but the
 * tests hand in a scripted clock so the statistics themselves can be asserted
 * exactly instead of "roughly, if the machine is not busy". A timing helper
 * whose own arithmetic is untested is not evidence of anything.
 *
 * Resolution limit, stated rather than hidden: each iteration is timed
 * individually, so an operation faster than the clock's resolution (~1µs under
 * Node, and deliberately coarser in cross-origin-isolated browsers) measures as
 * noise. Everything benchmarked here is tens of microseconds or more; anything
 * cheaper needs batching, which this helper does not do.
 */

export interface BenchmarkResult {
  readonly label: string;
  /** Timed iterations, excluding warmup. */
  readonly iterations: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  /** Reported only so a doc can show how far it sits from the median. */
  readonly mean: number;
  readonly totalMs: number;
  /** Derived from the median, not the mean, for the reason above. */
  readonly opsPerSecond: number;
}

export interface BenchmarkOptions {
  readonly iterations?: number;
  /**
   * Discarded iterations run before timing starts. V8 needs a few hundred calls
   * before it stops interpreting a hot function; without a warmup the first
   * samples measure the compiler, not the code.
   */
  readonly warmup?: number;
  /** Defaults to `performance.now`. Injected by the tests. */
  readonly now?: () => number;
}

const DEFAULT_ITERATIONS = 100;
const DEFAULT_WARMUP = 20;

/**
 * Nearest-rank percentile: index `ceil(fraction * n) - 1` of the sorted samples.
 *
 * No interpolation. Two reasons: the result is always a value that was actually
 * observed, which matters when it is quoted in a document someone may ask you
 * to defend, and there are half a dozen interpolating definitions that disagree
 * in the third decimal place for no benefit at this sample size.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) {
    throw new RangeError('percentile: no samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, fraction));
  const rank = Math.max(1, Math.ceil(clamped * sorted.length));
  // `sorted` is non-empty and `rank` is within [1, length], so the index is in
  // range - the fallback exists only because `noUncheckedIndexedAccess` cannot
  // know that, and returning NaN would be a worse lie than the last sample.
  return sorted[rank - 1] ?? sorted[sorted.length - 1] ?? 0;
}

/** Statistics over durations that were collected elsewhere. */
export function summarize(label: string, samples: readonly number[]): BenchmarkResult {
  if (samples.length === 0) {
    throw new RangeError(`summarize: "${label}" has no samples`);
  }
  const total = samples.reduce((sum, value) => sum + value, 0);
  const median = percentile(samples, 0.5);

  return {
    label,
    iterations: samples.length,
    median,
    p95: percentile(samples, 0.95),
    min: percentile(samples, 0),
    max: percentile(samples, 1),
    mean: total / samples.length,
    totalMs: total,
    // A median of exactly 0 means the operation is below the clock's
    // resolution. Infinity is the honest answer to "how many per second" -
    // dividing by a rounded-to-zero duration and printing a finite number would
    // invent precision the measurement does not have.
    opsPerSecond: median === 0 ? Infinity : 1000 / median,
  };
}

/**
 * Times `operation` over N iterations and returns the distribution.
 *
 * The operation's return value is passed to a sink that the optimiser cannot
 * see through, because V8 will otherwise delete a pure call whose result is
 * unused - and a benchmark of deleted code reports 0ms and looks like a triumph.
 */
export function benchmark(
  label: string,
  operation: () => unknown,
  options: BenchmarkOptions = {}
): BenchmarkResult {
  const { iterations = DEFAULT_ITERATIONS, warmup = DEFAULT_WARMUP, now = defaultNow } = options;

  for (let i = 0; i < warmup; i += 1) {
    sink(operation());
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = now();
    sink(operation());
    samples.push(now() - started);
  }

  return summarize(label, samples);
}

/** One line, fixed shape, so results paste into a document without reformatting. */
export function formatResult(result: BenchmarkResult, digits = 3): string {
  return (
    `${result.label}: median ${result.median.toFixed(digits)}ms · ` +
    `p95 ${result.p95.toFixed(digits)}ms · ` +
    `min ${result.min.toFixed(digits)}ms · max ${result.max.toFixed(digits)}ms ` +
    `(n=${result.iterations})`
  );
}

/**
 * Relative cost of two results, e.g. "hit-testing 2,000 elements costs 9.4× what
 * 200 do". The whole point of measuring both sizes is this ratio, so it is a
 * function rather than something every caller divides by hand.
 */
export function ratio(slower: BenchmarkResult, faster: BenchmarkResult): number {
  if (faster.median === 0) return Infinity;
  return slower.median / faster.median;
}

function defaultNow(): number {
  return performance.now();
}

/**
 * Dead-store elimination guard. Assigning to an exported binding the compiler
 * cannot prove is unread keeps the operation's result live.
 */
export let blackHole: unknown = null;

function sink(value: unknown): void {
  blackHole = value;
}
