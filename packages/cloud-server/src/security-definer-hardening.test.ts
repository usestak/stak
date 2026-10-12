import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static regression test for the SECURITY DEFINER privilege hardening in
 * 0007_security_definer_hardening.sql and 0008/0009's own new functions.
 *
 * There is no live Postgres/Supabase instance in this test environment, so this cannot
 * literally prove `anon`/`authenticated` are rejected by the database at runtime. What it
 * proves instead: the checked-in migration SQL actually contains the REVOKE/GRANT statements
 * for every SECURITY DEFINER function that takes a caller-controlled identity argument — so a
 * future edit that silently drops the hardening (e.g. during further refactors of these files)
 * fails this test immediately instead of only being caught by a manual re-audit.
 *
 * A real integration test against a live Supabase/Postgres instance would additionally need
 * to assert, per role:
 *   - `set role anon; select public.commit_environment_version(...);` raises
 *     `permission denied for function commit_environment_version` (and the same for
 *     commit_public_stack_version, commit_memory_generation, commit_user_stack_version,
 *     unpublish_public_stack, reactivate_public_stack).
 *   - the same calls raise identically under `set role authenticated;`.
 *   - `set role service_role;` (or the actual service-role JWT path the app uses) succeeds.
 *   - the app's own cloud-server test suites (already exercised elsewhere in this package)
 *     continue to pass end-to-end through that service-role path — i.e. hardening privileges
 *     did not also break the legitimate caller.
 */

const migrationsDir = join(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
);
const read = (name: string) => readFileSync(join(migrationsDir, name), 'utf8');

const revokedFromAll = (sql: string, fn: string) => {
  const revokePattern = new RegExp(
    `revoke all on function public\\.${fn}[^;]*from[^;]*;`,
    'i',
  );
  const matches = sql.match(new RegExp(revokePattern, 'gi')) ?? [];
  const combined = matches.join(' ').toLowerCase();
  // Either one combined `from public, anon, authenticated` statement, or three separate
  // single-role statements (0008_user_stacks.sql uses the three-statement form) — accept both.
  const hasPublic = /from[^;]*\bpublic\b/i.test(combined);
  const hasAnon =
    /from[^;]*\banon\b/i.test(combined) || /from\s+anon/i.test(sql);
  const hasAuthenticated =
    /from[^;]*\bauthenticated\b/i.test(combined) ||
    /from\s+authenticated/i.test(sql);
  return matches.length > 0 && hasPublic && hasAnon && hasAuthenticated;
};

const grantedToServiceRole = (sql: string, fn: string) => {
  const pattern = new RegExp(
    `grant execute on function public\\.${fn}[^;]*to service_role;`,
    'i',
  );
  return pattern.test(sql);
};

describe('SECURITY DEFINER privilege hardening (0007/0008/0009)', () => {
  const security = read('0007_security_definer_hardening.sql');
  const userStacks = read('0008_user_stacks.sql');
  const publicLifecycle = read('0009_public_share_lifecycle.sql');

  it('0007 is security-only: no new tables/columns/product schema', () => {
    expect(security).not.toMatch(/create table/i);
    expect(security).not.toMatch(/add column/i);
    expect(security).not.toMatch(/create policy/i);
    expect(security).not.toMatch(/enable row level security/i);
  });

  it.each([
    ['commit_environment_version', security],
    ['commit_public_stack_version', security],
    ['commit_memory_generation', security],
  ])(
    '%s is revoked from public/anon/authenticated and granted to service_role in 0007',
    (fn, sql) => {
      expect(revokedFromAll(sql, fn as string)).toBe(true);
      expect(grantedToServiceRole(sql, fn as string)).toBe(true);
    },
  );

  it.each([
    'forbid_version_update',
    'forbid_public_version_update',
    'forbid_memory_backup_mutation',
  ])('trigger function %s is revoked for defense-in-depth in 0007', (fn) => {
    expect(revokedFromAll(security, fn)).toBe(true);
  });

  it('0009 no longer duplicates the pre-existing 0001/0002 privilege fixes', () => {
    // 0009 may still mention these function names in prose (explaining where the fix moved
    // to), but must not contain an actual revoke/grant statement for them — that belongs
    // only in 0007 now.
    expect(revokedFromAll(publicLifecycle, 'commit_environment_version')).toBe(
      false,
    );
    expect(revokedFromAll(publicLifecycle, 'commit_public_stack_version')).toBe(
      false,
    );
    expect(
      grantedToServiceRole(publicLifecycle, 'commit_environment_version'),
    ).toBe(false);
    expect(
      grantedToServiceRole(publicLifecycle, 'commit_public_stack_version'),
    ).toBe(false);
  });

  it.each([
    'commit_user_stack_version',
    'unpublish_public_stack',
    'reactivate_public_stack',
  ])('new P10 function %s is service-role-only from creation', (fn) => {
    const sql =
      fn === 'commit_user_stack_version' ? userStacks : publicLifecycle;
    expect(grantedToServiceRole(sql, fn)).toBe(true);
  });

  it('all SECURITY DEFINER functions already use a safe, non-mutable search_path', () => {
    // 0007 defines no new functions (it only revokes/grants on pre-existing ones from
    // 0001-0003), so only 0008/0009 — which define new SECURITY DEFINER functions — apply.
    for (const sql of [userStacks, publicLifecycle]) {
      // Each function's signature-through-body header, up to its own `as $$`, so a mention of
      // "security definer" inside a prose comment elsewhere in the file can never bleed into
      // another function's block.
      const headers =
        sql.match(/create or replace function[\s\S]*?as \$\$/gi) ?? [];
      const definerHeaders = headers.filter((header) =>
        /security definer/i.test(header),
      );
      expect(definerHeaders.length).toBeGreaterThan(0);
      for (const header of definerHeaders) {
        expect(header.toLowerCase()).toContain('set search_path = public');
      }
    }
  });
});
