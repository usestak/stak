'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { canonicalizeUserStackName } from '@stack/spec';

import { createUserStackAction } from '../actions';

type ApprovedSkill = { skillId: string; name: string; paused: boolean };

type Step = 'name' | 'skills' | 'review';

/** `/stacks/new` — name, choose from approved Skills, review composition, create (P10B §11).
 *  Named Stacks are private by default and never affect `main` — creating one only reads the
 *  approved Skills already in `main`, never writes to it. */
export function NewStackForm({
  approvedSkills,
}: {
  approvedSkills: ApprovedSkill[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(
    () => approvedSkills.filter((s) => selected.has(s.skillId)),
    [approvedSkills, selected],
  );
  // Canonical name preview (spec P10 correction §5): the server trims/lowercases/validates
  // this exact same way, so showing it here means the name the user sees on later steps is
  // the one that will actually be stored, not a display illusion.
  const canonicalName = canonicalizeUserStackName(name);

  const toggle = (skillId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });

  const create = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await createUserStackAction({
      name: canonicalName,
      ...(description.trim() ? { description: description.trim() } : {}),
      skillIds: [...selected],
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/stacks/${result.stackId}`);
  };

  if (step === 'name')
    return (
      <div className="stak-stack-form-step">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. frontend"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--chip)',
              borderRadius: 6,
              background: '#151413',
              color: 'var(--ink)',
            }}
          />
          {name.trim() ? (
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>
              Saved as{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>
                {canonicalName || '(empty)'}
              </span>
              {canonicalName === 'main'
                ? ' — "main" is reserved and cannot be used.'
                : ''}
            </span>
          ) : null}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Description <span style={{ color: 'var(--dim)' }}>(optional)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this Stack is for"
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--chip)',
              borderRadius: 6,
              background: '#151413',
              color: 'var(--ink)',
            }}
          />
        </label>
        <div>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            disabled={canonicalName.length === 0 || canonicalName === 'main'}
            onClick={() => setStep('skills')}
          >
            Next: choose Skills
          </button>
        </div>
      </div>
    );

  if (step === 'skills')
    return (
      <div className="stak-stack-form-step">
        <span style={{ fontSize: 13 }}>
          Choose Skills for <strong>{canonicalName}</strong>
        </span>
        <div
          className="stak-stack-form-picker"
          role="group"
          aria-label="Choose Skills"
        >
          {approvedSkills.map((s) => (
            <label
              key={s.skillId}
              className={`stak-stack-form-picker-row${s.paused ? ' paused' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.has(s.skillId)}
                onChange={() => toggle(s.skillId)}
              />
              <span style={{ fontFamily: 'var(--mono)' }}>{s.name}</span>
              {s.paused ? (
                <span style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                  Paused in Main
                </span>
              ) : null}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            onClick={() => setStep('name')}
          >
            Back
          </button>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            disabled={selected.size === 0}
            onClick={() => setStep('review')}
          >
            Next: review ({selected.size} Skill{selected.size === 1 ? '' : 's'})
          </button>
        </div>
      </div>
    );

  return (
    <div className="stak-stack-form-step">
      <span style={{ fontSize: 13 }}>
        Review <strong>{canonicalName}</strong>
      </span>
      {description ? (
        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
          {description}
        </span>
      ) : null}
      <div style={{ border: '1px solid var(--line-2)', borderRadius: 8 }}>
        {chosen.map((s) => (
          <div key={s.skillId} className="stak-stack-edit-row">
            <span style={{ fontFamily: 'var(--mono)' }}>{s.name}</span>
            <span />
            <span />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          className="stak-pill"
          style={{ cursor: 'pointer' }}
          onClick={() => setStep('skills')}
          disabled={pending}
        >
          Back
        </button>
        <button
          type="button"
          className="stak-pill"
          style={{ cursor: 'pointer' }}
          onClick={create}
          disabled={pending}
        >
          {pending ? 'Creating…' : 'Create Stack'}
        </button>
      </div>
      <span
        role="status"
        aria-live="polite"
        style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}
      >
        {error ?? ''}
      </span>
    </div>
  );
}
