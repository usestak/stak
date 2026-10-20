export type AdminDateRange = '24h' | '7d' | '30d' | 'all';

const MS_PER_HOUR = 60 * 60 * 1000;

const OFFSET_HOURS: Record<Exclude<AdminDateRange, 'all'>, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/** The lower bound for a date-range filter, or null for "all time" (no bound). */
export const rangeStart = (range: AdminDateRange): Date | null => {
  if (range === 'all') return null;
  return new Date(Date.now() - OFFSET_HOURS[range] * MS_PER_HOUR);
};
