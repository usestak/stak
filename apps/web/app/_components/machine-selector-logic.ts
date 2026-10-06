/** Pure keyboard reducer for the machine listbox: the next active index for `count` options. */
export const nextActiveIndex = (
  current: number,
  key: string,
  count: number,
): number => {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return current;
  }
};

/** Above this many machines, the popover shows a search field to filter the list (P4 §3). */
export const SEARCH_THRESHOLD = 6;

/** Case-insensitive filter over an option's primary name + secondary line (P4 §3/§9). */
export const filterOptions = <T extends { name: string; secondary: string }>(
  options: T[],
  query: string,
): T[] => {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.name.toLowerCase().includes(q) || o.secondary.toLowerCase().includes(q),
  );
};
