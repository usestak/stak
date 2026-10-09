import type { MetadataRoute } from "next";
import { siteOrigin } from "../lib/site-origin";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/[owner]", "/[owner]/[slug]"],
      disallow: [
        "/overview",
        "/skills",
        "/memory",
        "/projects",
        "/machines",
        "/stacks",
        "/settings",
        "/onboarding",
        "/auth",
        "/cli",
      ],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
