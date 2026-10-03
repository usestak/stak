/**
 * Aliased environment variables for the Stack → STAK rebrand (Phase R3).
 *
 * `STAK_*` is the preferred public namespace from 0.1.0; the matching `STACK_*` name is
 * a supported legacy alias through the pre-1.0 compatibility period. Resolution is the
 * same fail-closed policy for every pair: use whichever one is set; if BOTH are set to
 * equivalent values accept it; if both are set to DIFFERENT values it is a configuration
 * error (never silently prefer one, merge, or copy). Error messages name the variables
 * only and NEVER echo a value, so this is safe for secrets.
 */
export type EnvEquivalence = (preferred: string, legacy: string) => boolean;

/** Resolve a `STAK_*` / `STACK_*` pair. Returns undefined when neither is set. */
export const resolveAliasedEnv = (options: {
  env: NodeJS.ProcessEnv;
  preferred: string;
  legacy: string;
  /** How to compare the two when both are set. Defaults to exact string equality. */
  equivalent?: EnvEquivalence;
}): string | undefined => {
  const { env, preferred, legacy } = options;
  const isEquivalent = options.equivalent ?? ((a, b) => a === b);
  const preferredValue = env[preferred];
  const legacyValue = env[legacy];
  if (preferredValue !== undefined && legacyValue !== undefined) {
    if (!isEquivalent(preferredValue, legacyValue))
      throw new Error(
        `STAK found different values for ${preferred} and legacy ${legacy}. ` +
          'Unset one, or set them to the same value. No changes were made.',
      );
    return preferredValue;
  }
  return preferredValue ?? legacyValue;
};

/** Equivalence for URL values: ignore a harmless trailing slash. */
export const sameUrlValue: EnvEquivalence = (a, b) =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Equivalence for numeric values: compare parsed numbers. */
export const sameNumericValue: EnvEquivalence = (a, b) =>
  Number(a) === Number(b);
