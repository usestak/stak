import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackFilter = 'all' | 'new' | 'bugs' | 'confusing' | 'ideas' | 'resolved';

export type FeedbackListRow = {
  id: string;
  type: string;
  messagePreview: string;
  contact: string | null;
  pageUrl: string | null;
  appVersion: string | null;
  createdAt: string;
  status: string;
};

const PREVIEW_LENGTH = 140;

const previewOf = (message: string): string =>
  message.length > PREVIEW_LENGTH ? `${message.slice(0, PREVIEW_LENGTH)}…` : message;

type FeedbackRow = {
  id: string;
  type: string;
  message: string;
  email: string | null;
  page_url: string | null;
  app_version: string | null;
  created_at: string;
  status: string;
};

// Row cap pending a proper paginated UI -- same accepted-exception category
// as every other admin list in this project (Phase 2/3 final reviews), and
// subject to the same real PostgREST 1000-row response cap regardless of
// this value.
const MAX_ROWS = 500;

export const loadFeedbackList = async (
  db: SupabaseClient,
  filter: FeedbackFilter,
): Promise<FeedbackListRow[]> => {
  let query = db
    .from('feedback')
    .select('id, type, message, email, page_url, app_version, created_at, status')
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (filter === 'new') query = query.eq('status', 'new');
  else if (filter === 'resolved') query = query.eq('status', 'resolved');
  else if (filter === 'bugs') query = query.eq('type', 'bug');
  else if (filter === 'confusing') query = query.eq('type', 'confusing');
  else if (filter === 'ideas') query = query.eq('type', 'idea');

  const { data, error } = await query;
  if (error) throw error;

  return ((data ?? []) as FeedbackRow[]).map((row) => ({
    id: row.id,
    type: row.type,
    messagePreview: previewOf(row.message),
    contact: row.email,
    pageUrl: row.page_url,
    appVersion: row.app_version,
    createdAt: row.created_at,
    status: row.status,
  }));
};
