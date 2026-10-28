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

/**
 * Shared by every admin page with a date-range picker (Overview, Usage,
 * Reliability), so there's one place that defines which ranges exist and
 * how a `?range=` query param is validated/defaulted.
 */
export const ADMIN_DATE_RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];

export const isAdminDateRange = (
  value: string | undefined,
): value is AdminDateRange =>
  ADMIN_DATE_RANGES.includes(value as AdminDateRange);
