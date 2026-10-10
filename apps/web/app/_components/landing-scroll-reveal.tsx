'use client';

import { useEffect } from 'react';

/**
 * Non-visual client island (P9 Task 3): arms the scroll-reveal motion on
 * `[data-reveal]` sections of the public landing page (feature strip, the
 * three truthful explainer sections, the closing bar) and reveals each one
 * the first time it enters the viewport.
 *
 * Progressive enhancement, deliberately conservative:
 * - Every `[data-reveal]` section is already fully visible in the
 *   server-rendered HTML (`public-landing-shell.css` has no base rule that
 *   hides it). This component only ever ADDS a class
 *   (`stak-reveal-armed`) that makes the CSS hide/offset it - so if this
 *   script never runs (JS disabled, bundle fails to load, etc.) nothing is
 *   ever hidden. No content exists only after this effect runs.
 * - If `IntersectionObserver` isn't available, or anything else throws, the
 *   armed class is never added and sections stay exactly as rendered.
 * - `prefers-reduced-motion: reduce` skips arming entirely - content stays
 *   immediately visible with no scroll-choreography dependency.
 * - A 2.5s fallback timer reveals every armed section regardless of
 *   IntersectionObserver firing, so a section can never get stuck hidden
 *   (e.g. an element that's already in view but at an awkward threshold,
 *   or a browser quirk with the observer).
 */
export function LandingScrollReveal() {
  useEffect(() => {
    try {
      if (
        typeof window === 'undefined' ||
        typeof window.IntersectionObserver !== 'function'
      ) {
        return;
      }
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      const sections = Array.from(
        document.querySelectorAll<HTMLElement>('[data-reveal]'),
      );
      if (sections.length === 0) {
        return;
      }

      sections.forEach((section) => section.classList.add('stak-reveal-armed'));

      const reveal = (section: HTMLElement) => {
        section.classList.add('stak-reveal-visible');
      };

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              reveal(entry.target as HTMLElement);
              observer.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
      );
      sections.forEach((section) => observer.observe(section));

      // Safety net: never leave a section armed-but-hidden indefinitely.
      const fallback = window.setTimeout(() => {
        sections.forEach(reveal);
        observer.disconnect();
      }, 2500);

      return () => {
        window.clearTimeout(fallback);
        observer.disconnect();
      };
    } catch {
      // Fail safe: if anything above throws, no class was added and every
      // section remains visible exactly as server-rendered.
      return;
    }
  }, []);

  return null;
}
