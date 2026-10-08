import { NextResponse, type NextRequest } from 'next/server';

import { safeNext } from '@/lib/safe-next';
import { supabaseServerClient } from '@/lib/supabase-server';

import { resolveCallbackTarget } from './resolve-callback-target.js';

export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  let exchangeFailed = false;
  if (code) {
    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    exchangeFailed = Boolean(error);
  }
  const target = resolveCallbackTarget({ code, next, exchangeFailed });
  return NextResponse.redirect(new URL(target, request.nextUrl.origin));
};
