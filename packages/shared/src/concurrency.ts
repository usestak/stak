/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input order in
 * the result.
 *
 * On failure: no new work starts, every call already in flight is allowed to settle (so no
 * rejection is left unobserved and nothing keeps running after this returns), and then the
 * promise rejects with the FIRST error thrown — first in time, not by item or worker index.
 * Later errors from calls that were already in flight are dropped.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.min(
    items.length,
    Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : items.length,
  );
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  // Workers never reject (errors are captured above), so awaiting them all cannot leave
  // an unhandled rejection behind.
  await Promise.all(Array.from({ length: width }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
};
