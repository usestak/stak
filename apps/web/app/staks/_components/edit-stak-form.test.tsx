import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const updateUserStackAction = vi.fn();
const publishUserStackAction = vi.fn();
const unpublishUserStackAction = vi.fn();
const getUserStackPublicationStatusAction = vi.fn();
vi.mock('../actions', () => ({
  updateUserStackAction: (...args: unknown[]) => updateUserStackAction(...args),
  publishUserStackAction: (...args: unknown[]) =>
    publishUserStackAction(...args),
  unpublishUserStackAction: (...args: unknown[]) =>
    unpublishUserStackAction(...args),
  getUserStackPublicationStatusAction: (...args: unknown[]) =>
    getUserStackPublicationStatusAction(...args),
}));

import { EditStakForm } from './edit-stak-form';

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const detail = {
  stackId: 'stack-1',
  name: 'frontend-test',
  description: 'A small frontend STAK for testing public sharing.',
  skills: [
    {
      skillId: 'skill-1',
      name: 'ByteRover',
      contentHash: `sha256:${'a'.repeat(64)}`,
      metadata: { name: 'ByteRover', description: 'A test Skill.' },
      restoration: {
        strategy: 'snapshot' as const,
        contentHash: `sha256:${'a'.repeat(64)}`,
        reason: 'local' as const,
      },
      observedSources: [],
      paused: false,
    },
  ],
  version: {
    versionId: 'v1',
    versionNumber: 1,
    createdAt: '2026-01-01T00:00:00Z',
  },
};
const approvedSkills = [
  { skillId: 'skill-1', name: 'ByteRover', paused: false },
];

const PUBLISHED_URL = 'https://www.memstk.com/stephentony100/frontend-test';

/** Default detail view (web UX simplification): shows the composition read-only, with an
 *  explicit `Edit STAK` action, rather than reopening the full creation form. */
test('a newly-loaded STAK detail defaults to a view, not the full Skill selector', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  expect(
    screen.queryByRole('group', { name: /skills in this stak/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /review changes/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /edit stak/i }),
  ).toBeInTheDocument();
});

test('view mode shows the selected Skills as a readable list with a count', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  expect(screen.getByText(/skills \(1\)/i)).toBeInTheDocument();
  expect(screen.getByText('ByteRover')).toBeInTheDocument();
});

test('Edit STAK reveals the existing name/description/Skill-selector editor', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /edit stak/i }));

  expect(
    screen.getByRole('group', { name: /skills in this stak/i }),
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText('What this STAK is for')).toHaveValue(
    detail.description,
  );
  expect(
    screen.getByRole('button', { name: /review changes/i }),
  ).toBeInTheDocument();
});

test('published state shows the canonical share URL, never the @owner CLI form', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  const link = screen.getByRole('link', { name: PUBLISHED_URL });
  expect(link).toHaveAttribute('href', PUBLISHED_URL);
  expect(link.getAttribute('href')).not.toContain('@');
  expect(
    screen.getByRole('link', { name: /open public page/i }),
  ).toHaveAttribute('href', PUBLISHED_URL);
});

test('changed-since-published surfaces "Unpublished changes" with a Republish action, no invented dirty state', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'changed-since-published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/unpublished changes/i)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /republish/i }),
  ).toBeInTheDocument();
});

test('private renders a safe Publish action using the STAK name as the initial slug, nothing else', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  expect(screen.getByLabelText(/public slug/i)).toHaveValue(detail.name);
  expect(
    screen.getByRole('button', { name: /^publish$/i }),
  ).toBeInTheDocument();
});

/** Regression: the server rejects publishing a Stack whose description is empty (every
 *  reader — `stak use`, `stak try`, the web Stack page — requires a non-empty one), so the
 *  Publish action must guard against it client-side too, right where the user can fix it. */
test('Publish is disabled with an empty description, and enabled once one is typed', () => {
  render(
    <EditStakForm
      detail={{ ...detail, description: '' }}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  expect(screen.getByText(/required to publish/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/description to publish/i), {
    target: { value: 'A small frontend STAK.' },
  });

  expect(screen.getByRole('button', { name: /^publish$/i })).toBeEnabled();
  expect(screen.queryByText(/required to publish/i)).not.toBeInTheDocument();
});

/** Regression: an edited description must be SAVED to the draft before publishing, not sent
 *  as a one-off override to `publishUserStackAction` — an override made the published
 *  bundle's description diverge from the saved draft, which permanently broke the
 *  "Unpublished changes" status check (it rebuilds its comparison hash from the saved draft
 *  alone) even right after a successful publish. */
test('clicking Publish with an edited description saves it to the draft first, then publishes without an override', async () => {
  updateUserStackAction.mockResolvedValue({ ok: true, versionNumber: 2 });
  publishUserStackAction.mockResolvedValue({ ok: true, result: {} });
  getUserStackPublicationStatusAction.mockResolvedValue({
    ok: true,
    status: { status: 'private' },
  });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.change(screen.getByLabelText(/description to publish/i), {
    target: { value: 'Updated before publishing.' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));

  await waitFor(() => expect(publishUserStackAction).toHaveBeenCalled());

  expect(updateUserStackAction).toHaveBeenCalledWith(
    expect.objectContaining({
      stackId: 'stack-1',
      description: 'Updated before publishing.',
    }),
  );
  expect(publishUserStackAction).toHaveBeenCalledWith(
    expect.not.objectContaining({ description: expect.anything() }),
  );
});

/** Regression for the Vercel release-blocking type error: `upload-required` intentionally
 *  carries no owner/slug/url/versionNumber, so the UI must never assume them — not even for
 *  the initial slug input's default value. */
test('upload-required renders without accessing slug/url metadata, tells the user to push, and offers no Publish action', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'upload-required' }}
    />,
  );

  expect(screen.getByText(/upload required/i)).toBeInTheDocument();
  expect(screen.getByText('stak push').tagName).toBe('CODE');
  expect(
    screen.queryByRole('button', { name: /^publish$/i }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/public slug/i)).not.toBeInTheDocument();
});

test('portable-republish-needed uses its existing publication metadata and offers a Republish action', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'portable-republish-needed',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/portable republish needed/i)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: PUBLISHED_URL });
  expect(link).toHaveAttribute('href', PUBLISHED_URL);
  expect(
    screen.getByRole('button', { name: /republish/i }),
  ).toBeInTheDocument();
});

test('Unpublish still calls the existing unpublish action', async () => {
  unpublishUserStackAction.mockResolvedValue({ ok: true });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /^unpublish$/i }));
  fireEvent.click(screen.getByRole('button', { name: /stop publishing/i }));

  expect(unpublishUserStackAction).toHaveBeenCalledWith('stack-1');
});

/** Regression for the known gap this task fixes: the private detail/edit page received
 *  `description` from the server (it's always present in UserStackDetail) but never
 *  rendered or let the user edit it. */
test('the edit form shows the STAK description and lets it be edited', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /edit stak/i }));

  const input = screen.getByPlaceholderText('What this STAK is for');
  expect(input).toHaveValue(detail.description);
});

test('saving only sends description when it actually changed', async () => {
  updateUserStackAction.mockResolvedValue({ ok: true, versionNumber: 2 });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /edit stak/i }));
  fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
  fireEvent.click(screen.getByRole('button', { name: /save as new version/i }));

  expect(updateUserStackAction).toHaveBeenCalledWith(
    expect.not.objectContaining({ description: expect.anything() }),
  );
});

/**
 * Regression for the stale-publication-status bug: `router.refresh()` (triggered by
 * Realtime/BroadcastChannel invalidation, or by the component's own save/publish/unpublish
 * flow) re-renders this already-mounted component with a fresh `initialPublication` prop —
 * it never remounts it. The Publish section must reconcile to that fresh prop without a
 * full browser reload.
 */
test('a fresh initialPublication prop (no remount) flips Published to Unpublished changes', () => {
  const { rerender } = render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/^published$/i)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /republish/i }),
  ).not.toBeInTheDocument();

  rerender(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'changed-since-published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.queryByText(/^published$/i)).not.toBeInTheDocument();
  expect(screen.getByText(/unpublished changes/i)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /republish/i }),
  ).toBeInTheDocument();
});

test('a fresh initialPublication prop (no remount) flips Unpublished changes back to Published', () => {
  const { rerender } = render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'changed-since-published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/unpublished changes/i)).toBeInTheDocument();

  rerender(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/^published$/i)).toBeInTheDocument();
  expect(screen.queryByText(/unpublished changes/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /republish/i }),
  ).not.toBeInTheDocument();
});

test('clicking Republish flips the UI to Published without a reload', async () => {
  publishUserStackAction.mockResolvedValue({ ok: true });
  getUserStackPublicationStatusAction.mockResolvedValue({
    ok: true,
    status: {
      status: 'published',
      owner: 'stephentony100',
      slug: 'frontend-test',
      url: PUBLISHED_URL,
      versionNumber: 2,
    },
  });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{
        status: 'changed-since-published',
        owner: 'stephentony100',
        slug: 'frontend-test',
        url: PUBLISHED_URL,
        versionNumber: 1,
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /republish/i }));

  await screen.findByText(/^published$/i);
  expect(screen.queryByText(/unpublished changes/i)).not.toBeInTheDocument();
});

test('editing the description includes it in the save payload', async () => {
  updateUserStackAction.mockResolvedValue({ ok: true, versionNumber: 2 });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /edit stak/i }));
  fireEvent.change(screen.getByPlaceholderText('What this STAK is for'), {
    target: { value: 'Updated description.' },
  });
  fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
  expect(screen.getByText('Updated description.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /save as new version/i }));

  expect(updateUserStackAction).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'Updated description.' }),
  );
});
