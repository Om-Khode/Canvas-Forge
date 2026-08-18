/**
 * Forward-only schema migration chain.
 *
 * Every serialized project carries a `schemaVersion`. On load the document is
 * walked forward one version at a time until it reaches
 * `CURRENT_SCHEMA_VERSION`, then validated. Splitting migration from validation
 * matters: a migration's job is to make an *old but well-formed* document look
 * current, and the validator's job is to defend against a *malformed* one. If
 * migrations also had to cope with garbage input, every future migration would
 * need to re-implement half the validator.
 *
 * A file from a newer version is refused outright rather than best-effort
 * parsed. Best-effort is the worse failure: the unknown fields are silently
 * dropped, the user saves over the file, and the data is gone. A clear "this
 * project was made with a newer version of CanvasForge" leaves the file intact.
 *
 * ── Adding a migration when the model changes breakingly ─────────────────────
 *
 * Say v3 replaces `TextElement.color` with a `fill`/`stroke` pair:
 *
 *   1. Bump `CURRENT_SCHEMA_VERSION` to 3 in `constants/storage.ts`.
 *   2. Add `2: (doc) => …` to `migrations` below - keyed by the version it
 *      reads *from*, producing a v3 document.
 *   3. Add a fixture test with a real v2 document asserting the v3 output.
 *
 * Migrations receive `unknown` and must not assume anything. They are also
 * permanent: a v1 file can appear five years from now, so a migration is never
 * deleted and never edited to change its output for inputs it already handled.
 */

import { CURRENT_SCHEMA_VERSION } from '@/constants/storage';
import { err, ok, type Result } from '@/services/result';

export type Migration = (doc: unknown) => unknown;

/** Keyed by source version: `migrations[n]` upgrades a v`n` document to v`n+1`. */
export type MigrationChain = Readonly<Record<number, Migration>>;

export type MigrationErrorKind =
  'not-an-object' | 'missing-version' | 'newer-version' | 'missing-migration' | 'migration-failed';

export interface MigrationError {
  readonly kind: MigrationErrorKind;
  readonly message: string;
}

export interface MigrationOutcome {
  readonly doc: unknown;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Source versions of the migrations that ran, in order. Empty when current. */
  readonly applied: readonly number[];
}

/** The live chain. */
export const migrations: MigrationChain = {
  /**
   * v1 → v2: `elements` went from a flat array to a nested forest, groups
   * carrying their members inline.
   *
   * Near identity, and that is the interesting part rather than a shortcut.
   * This is *not* because a v1 document cannot contain a group - migrations
   * assert nothing about their input, a hand-written file can declare any
   * `type` it likes, and validation (which runs after migration, on the
   * current-schema shape) is the only trust boundary. The reason this step is
   * near-identity is that v1's *shape* has no nesting: `elements` is already a
   * flat array, which is a valid v2 forest with every element a root and no
   * `children`. If a v1 file smuggles in a hand-written `type: 'group'` with
   * no `children` array, that is indistinguishable from any other malformed
   * element and validation drops it, same as it would post-migration. The step
   * still exists, is registered, and is tested, because a gap in the chain is
   * a hard error and "this version needs no work" is a claim that has to be
   * made explicitly rather than by omission.
   */
  1: (doc) => stampVersion(doc, 2),
};

function readVersion(doc: unknown): Result<number, MigrationError> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return err({ kind: 'not-an-object', message: 'This file is not a CanvasForge project.' });
  }
  if (!('schemaVersion' in doc)) {
    return err({
      kind: 'missing-version',
      message: 'This file has no schema version, so it cannot be read safely.',
    });
  }
  const raw = doc.schemaVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return err({
      kind: 'missing-version',
      message: `Invalid schema version: ${JSON.stringify(raw)}.`,
    });
  }
  return ok(raw);
}

/**
 * Runs `doc` forward to `targetVersion`.
 *
 * `chain` and `targetVersion` are parameters rather than module constants so
 * the mechanism can be tested with a synthetic v0→v1→v2 chain. Production
 * callers use the defaults.
 */
export function migrateDocument(
  doc: unknown,
  chain: MigrationChain = migrations,
  targetVersion: number = CURRENT_SCHEMA_VERSION
): Result<MigrationOutcome, MigrationError> {
  const version = readVersion(doc);
  if (!version.ok) return version;

  const fromVersion = version.value;
  if (fromVersion > targetVersion) {
    return err({
      kind: 'newer-version',
      message: `This project was created with a newer version of CanvasForge (schema ${fromVersion}). This build reads up to schema ${targetVersion}. Update the app to open it.`,
    });
  }

  let current = doc;
  const applied: number[] = [];

  for (let version_ = fromVersion; version_ < targetVersion; version_++) {
    const step = chain[version_];
    if (!step) {
      return err({
        kind: 'missing-migration',
        message: `No migration is registered from schema ${version_} to ${version_ + 1}.`,
      });
    }
    try {
      current = step(current);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return err({
        kind: 'migration-failed',
        message: `Migration from schema ${version_} to ${version_ + 1} failed: ${detail}`,
      });
    }
    applied.push(version_);
  }

  return ok({
    doc: stampVersion(current, targetVersion),
    fromVersion,
    toVersion: targetVersion,
    applied,
  });
}

/**
 * Belt and braces: the chain's contract is that each step bumps
 * `schemaVersion`, but a migration that forgets would leave the document
 * looking older than it is and re-run the chain on the next load. Stamping the
 * target once at the end makes that class of mistake unobservable.
 */
function stampVersion(doc: unknown, version: number): unknown {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return doc;
  return { ...doc, schemaVersion: version };
}
