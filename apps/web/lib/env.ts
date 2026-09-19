const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const cloudEnv = () => ({
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  ticketSecret: required('STACK_TICKET_SECRET'),
  appUrl: process.env.STACK_APP_URL ?? 'http://localhost:3000',
  bucket: process.env.STACK_SNAPSHOT_BUCKET ?? 'stack-snapshots',
  maxSnapshotBytes: Number(process.env.STACK_MAX_SNAPSHOT_BYTES ?? 209715200),
});
