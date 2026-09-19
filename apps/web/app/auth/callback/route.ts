import { NextResponse, type NextRequest } from 'next/server';

import { safeNext } from '@/lib/safe-next';
import { supabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  if (code) {
    const supabase = await supabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, request.nextUrl.origin));
};
