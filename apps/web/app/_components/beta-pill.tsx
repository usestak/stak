import Link from 'next/link';

import { PUBLIC_BETA_LABEL } from '../../lib/beta';

export function BetaPill() {
  return (
    <Link href="/beta" className="stak-landing-beta-pill">
      {PUBLIC_BETA_LABEL}
    </Link>
  );
}
