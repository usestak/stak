/** Shared presentation helpers for the Cloud UI (mirrors CLI terminology). */

export const skillCount = (count: number): string =>
  `${count} skill${count === 1 ? '' : 's'}`;

/** Compact relative time such as "just now", "3 hours ago", "2 days ago". */
export const relativeTime = (
  iso: string,
  nowMs: number = Date.now(),
): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const ranges: Array<[number, string]> = [
    [year, 'year'],
    [month, 'month'],
    [week, 'week'],
    [day, 'day'],
    [hour, 'hour'],
    [minute, 'minute'],
  ];
  for (const [unitSeconds, name] of ranges)
    if (seconds >= unitSeconds) {
      const value = Math.floor(seconds / unitSeconds);
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  return 'just now';
};
