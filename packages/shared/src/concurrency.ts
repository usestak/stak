/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input order in
 * the result. Rejects with the first error once in-flight work settles; no new work starts
 * after a failure.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  const settled = await Promise.allSettled(workers);
  const rejection = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  );
  if (rejection) throw rejection.reason;
  return results;
};
