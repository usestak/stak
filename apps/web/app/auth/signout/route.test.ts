import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase-server', () => ({
  supabaseServerClient: vi.fn(async () => ({
    auth: { signOut: vi.fn(async () => undefined) },
  })),
}));

import { POST } from './route';
import { ACTIVE_MACHINE_COOKIE } from '@/lib/machine-preference';

describe('signout route', () => {
  it('clears the active-machine preference so the next account never inherits it', async () => {
    const request = new NextRequest('https://www.memstk.com/auth/signout');
    const response = await POST(request);
    const cleared = response.cookies.get(ACTIVE_MACHINE_COOKIE);
    // next/server represents a deletion as the cookie present with an empty
    // value (and an immediately-expired Max-Age) rather than literally absent.
    expect(cleared?.value).toBe('');
  });
});
