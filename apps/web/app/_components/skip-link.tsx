/**
 * Skip link (WCAG 2.4.1 Bypass Blocks): the first focusable element on every page, rendered
 * once in the root layout — outside any shell's `.stak` scope, so it is present identically
 * for the signed-in shell, `FocusedShell`, and `PublicShell`. Visually hidden until it
 * receives keyboard focus (see `.stak-skip-link` in globals.css), then it jumps straight to
 * `id="main-content"`, which every shell's single `<main>` carries.
 */
export function SkipLink() {
  return (
    <a href="#main-content" className="stak-skip-link">
      Skip to main content
    </a>
  );
}
