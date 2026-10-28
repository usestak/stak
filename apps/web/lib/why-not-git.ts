/**
 * "Why not just use Git?" copy, shared verbatim between the public landing
 * page (`app/page.tsx` via `_components/public-landing-shell.tsx`) and the
 * `/beta` page (`app/beta/page.tsx`) so the two can never drift apart.
 *
 * Copy approved by the product owner — keep it verbatim; only heading level
 * and styling differ per page.
 */

export const WHY_NOT_GIT_EYEBROW = 'WHY NOT JUST USE GIT?';

export const WHY_NOT_GIT_HEADING =
  'Why not just put ~/.claude in a private Git repo?';

export interface WhyNotGitItem {
  lead: string;
  body: string;
}

export const WHY_NOT_GIT_ITEMS: WhyNotGitItem[] = [
  {
    lead: 'Your memory ends up in the wrong place.',
    body: "Claude saves each project's memory in a folder named after where that project sits on your computer. On a new laptop that location is usually different, so Claude can't find it. STAK recognises the project and puts its memory exactly where your new laptop expects it.",
  },
  {
    lead: 'Memory changes every day. Git makes you manage that by hand.',
    body: 'With Git you save, sync and fix clashes yourself — often right in the middle of your notes. STAK keeps memory in sync on its own and only asks you when the same note was changed on two machines.',
  },
  {
    lead: 'That folder holds much more than memory.',
    body: "It also has your chat history, temporary files and login details — things you shouldn't upload anywhere. STAK only syncs your memory and Skills, and can encrypt them so only you can read them.",
  },
  {
    lead: 'One memory for all your agents (coming soon).',
    body: 'Your Skills already work in Claude Code, Codex and Cursor. Shared project memory is next.',
  },
];
