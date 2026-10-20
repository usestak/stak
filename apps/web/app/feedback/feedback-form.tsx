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
      <div className="stak-feedback-success">
        <span className="stak-feedback-success-title" role="status">
          Thanks. This directly helps shape the public beta.
        </span>
        <span className="stak-feedback-success-body">
          We read every submission. If you left an email, we may follow up.
        </span>
      </div>
    );
  }

  return (
    <form className="stak-feedback-card" onSubmit={submit}>
      <div className="stak-feedback-field">
        <label className="stak-feedback-label" htmlFor="feedback-type">
          Type
        </label>
        <select
          id="feedback-type"
          className="stak-feedback-select"
          value={type}
          onChange={(e) => setType(e.target.value as FeedbackType)}
        >
          <option value="idea">Idea</option>
          <option value="bug">Bug</option>
          <option value="confusing">Something confusing</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div className="stak-feedback-field">
        <label className="stak-feedback-label" htmlFor="feedback-message">
          What happened, or what would you change?
        </label>
        <textarea
          id="feedback-message"
          className="stak-feedback-textarea"
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <div className="stak-feedback-field">
        <label className="stak-feedback-label" htmlFor="feedback-goal">
          What were you trying to do?{' '}
          <span className="stak-feedback-optional">Optional</span>
        </label>
        <textarea
          id="feedback-goal"
          className="stak-feedback-textarea"
          style={{ minHeight: 72 }}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>

      <div className="stak-feedback-field">
        <label className="stak-feedback-label" htmlFor="feedback-email">
          Email <span className="stak-feedback-optional">Optional</span>
        </label>
        <input
          id="feedback-email"
          className="stak-feedback-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <button
        type="submit"
        className="stak-feedback-submit"
        disabled={status === 'sending'}
      >
        {status === 'sending' ? 'Sending…' : 'Send feedback'}
      </button>
      {status === 'error' ? (
        <p className="stak-feedback-error" role="alert">
          Something went wrong. Try again.
        </p>
      ) : null}
    </form>
  );
}
