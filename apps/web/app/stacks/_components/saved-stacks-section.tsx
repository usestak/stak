import Link from 'next/link';

import type { SavedStackRow } from '../stacks-data';

/** Dense rows, matching the Skills list's vocabulary (contract: no SaaS card grid). Pure
 *  composition facts — no machine-installed/reconciliation state mixed in (contract §6/§17). */
export function SavedStacksSection({ stacks }: { stacks: SavedStackRow[] }) {
  if (stacks.length === 0)
    return (
      <p className="stak-saved-stacks-empty">
        No saved Stacks yet. A saved Stack is a named, reusable composition of
        your approved Skills — create one to group Skills for a project or
        client without changing Main.
      </p>
    );

  return (
    <div>
      <div className="stak-saved-stacks-head-row" role="row">
        <span>NAME</span>
        <span>SKILLS</span>
        <span>UPDATED</span>
      </div>
      {stacks.map((s) => (
        <Link
          key={s.stackId}
          href={`/stacks/${s.stackId}`}
          className="stak-saved-stack-row"
        >
          <span className="stak-saved-stack-name">{s.name}</span>
          <span>
            {s.skillCount} Skill{s.skillCount === 1 ? '' : 's'}
          </span>
          <span style={{ color: 'var(--faint)' }}>{s.updatedAtLabel}</span>
        </Link>
      ))}
    </div>
  );
}
