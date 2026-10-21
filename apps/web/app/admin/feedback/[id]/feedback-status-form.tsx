'use client';

/** Placeholder -- Task 3 replaces this with the real status/note form wired to PATCH /api/admin/feedback/[id]. */
export function FeedbackStatusForm({
  feedbackId,
}: {
  feedbackId: string;
  initialStatus: string;
  initialAdminNote: string;
}) {
  return <p>Status/note editing lands in the next task. (feedback id: {feedbackId})</p>;
}
