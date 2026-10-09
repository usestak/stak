import type { MetadataRoute } from "next";
import { siteOrigin } from "../lib/site-origin";

/**
 * Only the public landing page is included here. There is no safe
 * public-Stack enumeration API today: `@stack/cloud-server`'s
 * `listPublicStacksByHandle(handle)` lists Stacks for an already-known owner
 * handle, but there is no query to enumerate all public handles or all
 * public Stacks across owners. Hard-coding or guessing Stack URLs would
 * produce a sitemap with broken/fake entries, so this is deliberately
 * minimal until that enumeration API exists (tracked as a launch-checklist
 * item, not built here per YAGNI).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return [
    {
      url: origin,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
