'use client';

import { useState } from 'react';

type FeedbackType = 'bug' | 'confusing' | 'idea' | 'other';

export function FeedbackForm() {
  const [type, setType] = useState<FeedbackType>('idea');
  const [message, setMessage] = useState('');
  const [goal, setGoal] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle',
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          message,
          goal: goal || undefined,
          email: email || undefined,
          pageUrl:
            typeof window !== 'undefined'
              ? window.location.pathname
              : undefined,
        }),
      });
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return (
      <p role="status">Thanks. This directly helps shape the public beta.</p>
    );
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="feedback-type">Type</label>
      <select
        id="feedback-type"
        value={type}
        onChange={(e) => setType(e.target.value as FeedbackType)}
      >
        <option value="bug">Bug</option>
        <option value="confusing">Something confusing</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>

      <label htmlFor="feedback-message">
        What happened, or what would you change?
      </label>
      <textarea
        id="feedback-message"
        required
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <label htmlFor="feedback-goal">
        What were you trying to do? (optional)
      </label>
      <input
        id="feedback-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />

      <label htmlFor="feedback-email">Email (optional)</label>
      <input
        id="feedback-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <p>
        Please don&apos;t include credentials, secrets, or private Memory
        content.
      </p>

      <button type="submit" disabled={status === 'sending'}>
        Send feedback
      </button>
      {status === 'error' ? (
        <p role="alert">Something went wrong. Try again.</p>
      ) : null}
    </form>
  );
}
