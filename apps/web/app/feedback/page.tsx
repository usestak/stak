import type { Metadata } from 'next';

import { FeedbackForm } from './feedback-form';

export const metadata: Metadata = {
  title: 'Feedback',
  description: 'Tell us what worked, what was confusing, or what you expected during the STAK Public Beta.',
};

export default function FeedbackPage() {
  return (
    <main>
      <h1>Feedback</h1>
      <p>Short and specific is perfect. This goes straight to the people building STAK.</p>
      <FeedbackForm />
    </main>
  );
}
