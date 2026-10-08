import type { StackCard as StackCardData } from '../stacks-data';

export function StackCard({ stack }: { stack: StackCardData }) {
  return (
    <div className="stak-stack-card">
      <div className="stak-stack-card-head">
        <div>
          <div className="stak-stack-card-name">{stack.name}</div>
          <div className="stak-stack-card-meta">
            {stack.versionLabel} · updated {stack.updatedAtLabel}
          </div>
        </div>
        <span className="stak-stack-card-meta">
          {stack.skillCount} Skill{stack.skillCount === 1 ? '' : 's'}
        </span>
      </div>

      {stack.skills.length === 0 ? (
        <p className="stak-stack-composition-empty">
          This Stack has no Skills yet.
        </p>
      ) : (
        <>
          <div className="stak-stack-composition-head">
            <span>SKILL</span>
            <span>APPROVED</span>
            <span>STATUS</span>
          </div>
          {stack.skills.map((s) => (
            <div key={s.skillId} className="stak-stack-composition-row">
              <span style={{ fontFamily: 'var(--mono)' }}>{s.name}</span>
              <span
                style={{ fontFamily: 'var(--mono)', color: 'var(--faint)' }}
              >
                {s.approvedVersionShort}
              </span>
              <span style={{ color: s.paused ? 'var(--faint)' : 'var(--ink)' }}>
                {s.paused ? 'Paused' : 'Ready'}
              </span>
            </div>
          ))}
        </>
      )}

      <div className="stak-stack-technical">
        Technical details — environment id {stack.environmentId}
      </div>
    </div>
  );
}
