import type { MetadataRoute } from 'next';
import { siteOrigin } from '../lib/site-origin';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      // No explicit `allow` list: public paths (/, /[owner], /[owner]/[slug]) are already
      // crawlable by default since they're absent from `disallow` below. A literal
      // "/[owner]" allow entry would never match a real URL (Next's route brackets are a
      // file-system convention, not what renders in the path) and was a no-op.
      disallow: [
        '/overview',
        '/skills',
        '/memory',
        '/projects',
        '/machines',
        '/staks',
        '/settings',
        '/onboarding',
        '/auth',
        '/cli',
      ],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
