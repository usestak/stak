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
