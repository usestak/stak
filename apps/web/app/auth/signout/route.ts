import { NextResponse, type NextRequest } from 'next/server';

import { supabaseServerClient } from '@/lib/supabase-server';
import { ACTIVE_MACHINE_COOKIE } from '@/lib/machine-preference';

export const dynamic = 'force-dynamic';

/** End the browser session and return to the public landing page. Also clears
 *  the "last viewed machine" preference (defense in depth, see
 *  `lib/machine-preference.ts`) so the next signed-in account on this browser
 *  never even has a stale cookie value to see — though it was never trusted
 *  as authorization regardless. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const supabase = await supabaseServerClient();
  await supabase.auth.signOut();
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin), {
    status: 303,
  });
  response.cookies.delete(ACTIVE_MACHINE_COOKIE);
  return response;
};
