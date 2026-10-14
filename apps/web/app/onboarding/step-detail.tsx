import { InlineCommand } from '../_components/inline-command';

/** `OnboardingStep.detail` is authored with backtick-quoted commands (e.g. "Run
 *  `stak login` and approve it here in your browser.") - split on them so every
 *  genuine command renders as a real, clickable InlineCommand instead of a literal
 *  backtick character. Isolated from page.tsx (a server page with server-only
 *  imports) so it can be unit-tested without pulling those in. */
export const renderStepDetail = (detail: string) =>
  detail
    .split('`')
    .map((part, i) =>
      i % 2 === 1 ? <InlineCommand key={i} command={part} /> : part,
    );
