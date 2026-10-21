import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AppSidebar } from '@/app/_components/app-sidebar';
import { CommandDock } from '@/app/_components/command-dock';
import { InlineCommand } from '@/app/_components/inline-command';
import { MachineChooser } from '@/app/_components/machine-chooser';
import { ShellNotice } from '@/app/_components/shell-notice';
import { getCloudService } from '@/lib/cloud-service';
import { readActiveMachinePreference } from '@/lib/machine-preference';
import { displayNameOf, getSessionUser } from '@/lib/session';

import {
  loadOverview,
  type NeedsAttentionView,
  type OverviewMachineCard,
} from './overview-data';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const DOT: Record<string, string> = {
  ready: '#84cb8e',
  attention: '#ee7a3b',
  neutral: '#a19d94',
};

const AttentionRow = ({ item }: { item: NeedsAttentionView }) => (
  <div className="stak-attn">
    <span
      className="stak-status"
      style={{ color: item.dot === 'attention' ? '#ee7a3b' : '#c9c5bc' }}
    >
      {item.dot === 'attention' ? (
        <span
          className="stak-dot"
          style={{ background: '#ee7a3b' }}
          aria-hidden
        />
      ) : (
        <span
          className="stak-dot"
          style={{ border: '1.5px solid #8a867e', background: 'transparent' }}
          aria-hidden
        />
      )}
      {item.statusLabel}
    </span>
    <div>
      <div style={{ fontSize: 14, fontFamily: 'var(--mono)' }}>
        {item.title}
      </div>
      <div style={{ fontSize: 12.5, color: '#a19d94', marginTop: 3 }}>
        {item.why} {item.action}
      </div>
    </div>
    <span className="stak-pill">{actionLabel(item.kind)}</span>
  </div>
);

const actionLabel = (kind: NeedsAttentionView['kind']): string =>
  kind === 'update-available'
    ? 'Review changes'
    : kind === 'project-not-on-machine'
      ? 'How to map'
      : 'Details';

const MachineCard = ({ card }: { card: OverviewMachineCard }) => (
  <div className="stak-mcard">
    <span
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 13.5,
        gap: 10,
      }}
    >
      <span style={{ fontWeight: 600 }}>{card.name}</span>
      <span className="stak-status" style={{ color: '#c9c5bc' }}>
        <span
          className="stak-dot"
          style={{ background: DOT[card.dot] }}
          aria-hidden
        />
        {card.status}
      </span>
    </span>
    <span style={{ fontSize: 12, color: '#85817a' }}>{card.meta}</span>
    {card.checkedIn && card.facts ? (
      <>
        <span style={{ fontSize: 12, color: '#a19d94' }}>{card.seen}</span>
        <span style={{ fontSize: 12, color: '#85817a' }}>
          {card.facts.skills} · {card.facts.projects} · {card.facts.memory}
        </span>
        <span style={{ fontSize: 12, color: '#85817a' }}>
          {card.facts.agents}
        </span>
      </>
    ) : (
      <span style={{ fontSize: 12, color: '#85817a', lineHeight: 1.5 }}>
        This machine hasn&apos;t reported its STAK state yet. Run{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>stak status</span> on it.
      </span>
    )}
  </div>
);

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine: requestedMachine } = await searchParams;
  const machine = requestedMachine ?? (await readActiveMachinePreference());
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadOverview(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice
        active="overview"
        handle={handle}
        title="Couldn't load your Overview"
      >
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="overview" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <InlineCommand command="stak login" />, then{' '}
          <InlineCommand command="stak init" />.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="overview" handle={handle} title="Choose a machine">
        <p>
          STAK shows machine-specific state from that machine&apos;s last CLI
          check-in. Pick the machine you want to view — or run{' '}
          <InlineCommand command="stak open" /> on a machine to jump straight
          there.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <InlineCommand command="stak status" /> on the machine you want STAK
            to inspect, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="overview"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span
              className="stak-dot"
              style={{
                width: 10,
                height: 10,
                background: view.backedUp ? '#84cb8e' : '#e5b85c',
              }}
              aria-hidden
            />
            <h1>{view.headline}</h1>
          </div>
          <span className="stak-sub">{view.detail}</span>
        </div>

        <div className="stak-summaries">
          {[
            view.summaries.skills,
            view.summaries.memory,
            view.summaries.projects,
            view.summaries.machines,
          ].map((s) => (
            <div className="stak-sum" key={s.label}>
              <span className="k">{s.label}</span>
              <span className="v">{s.value}</span>
              <span className="d">{s.detail}</span>
            </div>
          ))}
        </div>

        <div className="stak-body">
          <div className="stak-col">
            <section
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <h2>Needs attention</h2>
              {view.needsAttention.length > 0 ? (
                <div className="stak-list">
                  {view.needsAttention.map((item) => (
                    <AttentionRow
                      key={`${item.kind}:${item.title}`}
                      item={item}
                    />
                  ))}
                </div>
              ) : (
                <p
                  style={{ fontSize: 13, color: '#85817a', margin: '6px 0 0' }}
                >
                  Nothing needs you right now.
                </p>
              )}
            </section>
            <section
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <h2>Recent activity</h2>
              <div className="stak-list">
                {view.activity.length > 0 ? (
                  view.activity.map((a, index) => (
                    <div className="stak-act" key={index}>
                      <span style={{ color: '#c9c5bc' }}>{a.what}</span>
                      <span style={{ color: '#a19d94' }}>{a.detail}</span>
                      <span
                        style={{ font: '12px var(--mono)', color: '#85817a' }}
                      >
                        {a.when}
                      </span>
                    </div>
                  ))
                ) : (
                  <p
                    style={{
                      fontSize: 13,
                      color: '#85817a',
                      margin: '6px 0 0',
                    }}
                  >
                    Activity appears as you back up Memory and your machines
                    check in.
                  </p>
                )}
              </div>
            </section>
          </div>
          <aside className="stak-rail">
            <h2>Machines</h2>
            {view.machineCards.map((card) => (
              <MachineCard key={card.machineId} card={card} />
            ))}
            {view.overflowCount > 0 ? (
              <span
                className="stak-mcard"
                aria-disabled="true"
                style={{
                  color: '#85817a',
                  fontSize: 12.5,
                  textAlign: 'center',
                }}
              >
                +{view.overflowCount} more · {view.machineTotal} machines total
              </span>
            ) : null}
            <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#85817a' }}>
              Machines catch up when you use the CLI on them. Status reflects
              each machine&apos;s last check-in — not a live connection.
            </span>
          </aside>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={view.dockCommand}
          hint="Back up after a long session"
        />
      </main>
    </div>
  );
}
