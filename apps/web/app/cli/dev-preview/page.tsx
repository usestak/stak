import { notFound } from 'next/navigation';

import {
  CliApprovalCard,
  CliApprovalShell,
} from '@/app/_components/cli-approval-shell';

/**
 * Dev-only visual harness for the 4 CLI-approval states (P9 Task 4), rendered against
 * local fixture data — never a real backend session. Exists purely so the 4 states can
 * be screenshotted without ever creating a real CLI authorization request against the
 * real account (a global constraint for this task).
 *
 * Why this is structurally safe to ship in the repo at all:
 *  - `process.env.NODE_ENV` is set to `'production'` by every real production build/run
 *    (Next.js sets it itself; nothing here can override that at runtime). The check below
 *    is a plain request-time condition, not a bundler dead-code-elimination trick, so it
 *    can't be defeated by a flag, header, or query string — there is no branch that skips
 *    it. In a production deployment this route always 404s, for every request, with no
 *    exception.
 *  - It takes no input from the request that lets it reach real data: `state` only ever
 *    selects between four hardcoded local fixture objects defined in this file. It never
 *    calls `getCloudService()`, `approveCliAuth`, or any other real backend/auth path, so
 *    even if someone found this route in production, there would be nothing to bypass —
 *    it has no write path and no read path into real sessions.
 *  - It is not linked from anywhere in the real app (no nav, no metadata, no sitemap) and
 *    carries the same `noindex` posture as the rest of /cli.
 */
export const dynamic = 'force-dynamic';

const FIXTURES = {
  'pending-labeled': {
    label: 'Fixture A1 — pending, with label',
    code: 'KQTR-4821',
    ui: (
      <CliApprovalShell code="KQTR-4821" waiting>
        <CliApprovalCard
          heading="Approve this machine?"
          sub={
            <>
              A terminal asked to connect to Dana&rsquo;s STAK. Only approve if
              you just ran{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
            </>
          }
          code="KQTR-4821"
          label="temi-laptop"
        >
          <div className="stak-cli-actions">
            <button className="stak-cli-approve">Approve this machine</button>
            <a className="stak-cli-decline" href="/">
              This wasn&rsquo;t me
            </a>
          </div>
          <p className="stak-cli-safety">
            Approving lets the CLI pull your skills and back up Memory.
            &ldquo;This wasn&rsquo;t me&rdquo; just leaves this page &mdash; it
            doesn&rsquo;t notify anyone.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
  'pending-unlabeled': {
    label: 'Fixture A2 — pending, no label',
    code: 'VPXN-7703',
    ui: (
      <CliApprovalShell code="VPXN-7703" waiting>
        <CliApprovalCard
          heading="Approve this machine?"
          sub={
            <>
              A terminal asked to connect to your STAK. Only approve if you just
              ran <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
            </>
          }
          code="VPXN-7703"
        >
          <div className="stak-cli-actions">
            <button className="stak-cli-approve">Approve this machine</button>
            <a className="stak-cli-decline" href="/">
              This wasn&rsquo;t me
            </a>
          </div>
          <p className="stak-cli-safety">
            Approving lets the CLI pull your skills and back up Memory.
            &ldquo;This wasn&rsquo;t me&rdquo; just leaves this page &mdash; it
            doesn&rsquo;t notify anyone.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
  expired: {
    label: 'Fixture B — expired code',
    code: 'FXQP-0019',
    ui: (
      <CliApprovalShell code="FXQP-0019">
        <CliApprovalCard heading="Authorize the Memory STAK CLI">
          <p className="stak-cli-error">This authorization code has expired.</p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
  unknown: {
    label: 'Fixture B2 — unrecognized code',
    code: '0000-0000',
    ui: (
      <CliApprovalShell code="0000-0000">
        <CliApprovalCard heading="Authorize the Memory STAK CLI">
          <p className="stak-cli-error">
            We don&rsquo;t recognize this code. It may have been mistyped.
          </p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
  success: {
    label: 'Fixture C — approval success',
    code: 'KQTR-4821',
    ui: (
      <CliApprovalShell code="KQTR-4821">
        <CliApprovalCard
          heading="Approve this machine?"
          sub={
            <>
              A terminal asked to connect to Dana&rsquo;s STAK. Only approve if
              you just ran{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
            </>
          }
          code="KQTR-4821"
          label="temi-laptop"
        >
          <p className="stak-cli-success">
            Authorized. You&rsquo;re connected.
          </p>
          <p className="stak-cli-safety">You can return to your terminal.</p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
  failure: {
    label: 'Fixture D — approval failure',
    code: 'FXQP-0019',
    ui: (
      <CliApprovalShell code="FXQP-0019">
        <CliApprovalCard
          heading="Approve this machine?"
          sub={
            <>
              A terminal asked to connect to Dana&rsquo;s STAK. Only approve if
              you just ran{' '}
              <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>.
            </>
          }
          code="FXQP-0019"
        >
          <div className="stak-cli-actions">
            <button className="stak-cli-approve">Approve this machine</button>
            <a className="stak-cli-decline" href="/">
              This wasn&rsquo;t me
            </a>
          </div>
          {/* Real error string from approveCliAuth (service.ts) for a session whose
              status flipped to non-pending between page load and the Approve click. */}
          <p className="stak-cli-error">
            This authorization request is no longer pending.
          </p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </CliApprovalCard>
      </CliApprovalShell>
    ),
  },
} as const;

type FixtureKey = keyof typeof FIXTURES;

export default async function CliDevPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();

  const { state } = await searchParams;
  const key = (
    state && state in FIXTURES ? state : 'pending-labeled'
  ) as FixtureKey;
  return FIXTURES[key].ui;
}
