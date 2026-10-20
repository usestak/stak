import { z } from 'zod';

/**
 * Website feedback submission contract. Intentionally has no field for local
 * paths, Memory content, Skill content, terminal output, or credentials —
 * the form never collects them, so the schema never accepts them. Unknown
 * keys are stripped (default Zod object behavior), not merely ignored.
 */
export const feedbackRequestSchema = z.object({
  type: z.enum(['bug', 'confusing', 'idea', 'other']),
  message: z.string().min(1).max(4000),
  goal: z.string().max(2000).optional(),
  email: z.string().email().max(320).optional(),
  pageUrl: z.string().max(2048).optional(),
});

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
