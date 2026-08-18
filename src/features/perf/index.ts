/**
 * Performance instrumentation.
 *
 * Two modules, both pure: a generator for a document large enough to be worth
 * measuring, and the timing helpers the measurements run through. Nothing here
 * imports React or the store - the stress document is applied to the store by
 * the editor route, not by this feature, so the generator stays testable and
 * the affordance stays where the URL is parsed.
 *
 * Findings live in `docs/performance.md`.
 */

export {
  createStressDocument,
  createStressElements,
  parseStressCount,
  DEFAULT_STRESS_COUNT,
  MAX_STRESS_COUNT,
  STRESS_PARAM,
  type StressDocumentOptions,
} from './stressDocument';

export {
  benchmark,
  formatResult,
  percentile,
  ratio,
  summarize,
  type BenchmarkOptions,
  type BenchmarkResult,
} from './benchmark';
