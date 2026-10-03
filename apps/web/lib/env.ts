const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

/**
 * Resolve a `STAK_*` / `STACK_*` aliased variable (Phase R3). `STAK_*` is preferred;
 * `STACK_*` is the supported legacy alias. If both are set to different values it is a
 * configuration error. The error names the variables only and never echoes a value, so
 * it is safe for secrets. `equivalent` lets URL/numeric forms compare by meaning.
 */
const aliased = (
  preferred: string,
  legacy: string,
  equivalent: (a: string, b: string) => boolean = (a, b) => a === b,
): string | undefined => {
  const preferredValue = process.env[preferred];
  const legacyValue = process.env[legacy];
  if (preferredValue !== undefined && legacyValue !== undefined) {
    if (!equivalent(preferredValue, legacyValue))
      throw new Error(
        `STAK found different values for ${preferred} and legacy ${legacy}. ` +
          'Unset one, or set them to the same value.',
      );
    return preferredValue;
  }
  return preferredValue ?? legacyValue;
};

const sameUrl = (a: string, b: string): boolean =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const sameNumber = (a: string, b: string): boolean => Number(a) === Number(b);

const requiredAliased = (preferred: string, legacy: string): string => {
  const value = aliased(preferred, legacy);
  if (!value)
    throw new Error(`Missing required environment variable: ${preferred}`);
  return value;
};

export const cloudEnv = () => ({
  // Third-party (Supabase) variable names are unchanged.
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  // First-party variables: STAK_* preferred, STACK_* accepted as legacy aliases.
  ticketSecret: requiredAliased('STAK_TICKET_SECRET', 'STACK_TICKET_SECRET'),
  appUrl:
    aliased('STAK_APP_URL', 'STACK_APP_URL', sameUrl) ??
    'http://localhost:3000',
  bucket:
    aliased('STAK_SNAPSHOT_BUCKET', 'STACK_SNAPSHOT_BUCKET') ??
    'stack-snapshots',
  maxSnapshotBytes: Number(
    aliased(
      'STAK_MAX_SNAPSHOT_BYTES',
      'STACK_MAX_SNAPSHOT_BYTES',
      sameNumber,
    ) ?? 209715200,
  ),
});
