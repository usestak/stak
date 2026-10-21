import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackDetail = {
  id: string;
  type: string;
  message: string;
  goal: string | null;
  email: string | null;
  pageUrl: string | null;
  userId: string | null;
  appVersion: string | null;
  createdAt: string;
  status: string;
  adminNote: string | null;
  resolvedAt: string | null;
};

type FeedbackDetailRow = {
  id: string;
  type: string;
  message: string;
  goal: string | null;
  email: string | null;
  page_url: string | null;
  user_id: string | null;
  app_version: string | null;
  created_at: string;
  status: string;
  admin_note: string | null;
  resolved_at: string | null;
};

export const loadFeedbackDetail = async (
  db: SupabaseClient,
  id: string,
): Promise<FeedbackDetail | null> => {
  const { data, error } = await db
    .from('feedback')
    .select(
      'id, type, message, goal, email, page_url, user_id, app_version, created_at, status, admin_note, resolved_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as FeedbackDetailRow;
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    goal: row.goal,
    email: row.email,
    pageUrl: row.page_url,
    userId: row.user_id,
    appVersion: row.app_version,
    createdAt: row.created_at,
    status: row.status,
    adminNote: row.admin_note,
    resolvedAt: row.resolved_at,
  };
};
