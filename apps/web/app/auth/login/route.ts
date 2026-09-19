import { NextResponse, type NextRequest } from 'next/server';

import { safeNext } from '@/lib/safe-next';
import { supabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${request.nextUrl.origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error || !data.url)
    return NextResponse.json(
      { error: 'Could not start GitHub sign-in.' },
      { status: 500 },
    );
  return NextResponse.redirect(data.url);
};
