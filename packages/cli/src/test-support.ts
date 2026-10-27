/** Test-only helper: narrows a possibly-missing value, failing fast (with a
 * clear message) instead of using a non-null assertion. Behaviorally
 * equivalent to the `!` it replaces — if the value were ever actually
 * missing, the test was already relying on it not being so. */
export function defined<T>(
  value: T | null | undefined,
  message = 'Expected value to be defined',
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}
