import { NextResponse, type NextRequest } from 'next/server';

import { supabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/** End the browser session and return to the public landing page. */
export const POST = async (request: NextRequest): Promise<Response> => {
  const supabase = await supabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', request.nextUrl.origin), {
    status: 303,
  });
};
