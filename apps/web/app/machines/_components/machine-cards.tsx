import type { MachineCard } from '../machines-data';
import { RevokeMachineButton } from './revoke-machine-button';

export function MachineCards({ cards }: { cards: MachineCard[] }) {
  return (
    <div className="stak-machines-grid">
      {cards.map((c) => (
        <div key={c.machineId} className="stak-machine-card">
          <div className="stak-machine-card-head">
            <div>
              <div className="stak-machine-card-name">{c.name}</div>
              <div className="stak-machine-card-meta">{c.meta}</div>
            </div>
            <div className="stak-machine-card-status">
              <span className="stak-status">
                <span
                  className="stak-dot"
                  style={{
                    background:
                      c.dot === 'ready'
                        ? '#84cb8e'
                        : c.dot === 'attention'
                          ? '#e5b85c'
                          : '#85817a',
                  }}
                  aria-hidden
                />
                {c.statusLabel}
              </span>
              {c.stale ? <span className="stak-stale-badge">Stale</span> : null}
            </div>
          </div>
          <div className="stak-machine-card-facts">
            <div>
              <div className="k">SKILLS</div>
              <div className="v">{c.skillsLabel}</div>
            </div>
            <div>
              <div className="k">PROJECTS</div>
              <div className="v">{c.projectsLabel}</div>
            </div>
            <div>
              <div className="k">MEMORY</div>
              <div className="v">{c.memoryLabel}</div>
            </div>
            <div>
              <div className="k">AGENTS</div>
              <div className="v">{c.agentsLabel}</div>
            </div>
          </div>
          <div className="stak-machine-card-foot">
            <RevokeMachineButton
              machineId={c.machineId}
              machineName={c.name}
              isOnlyActiveMachine={c.isOnlyActiveMachine}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
