import { NextResponse, type NextRequest } from 'next/server';

import { supabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const code = request.nextUrl.searchParams.get('code');
  const next = request.nextUrl.searchParams.get('next') ?? '/cli';
  if (code) {
    const supabase = await supabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, request.nextUrl.origin));
};
