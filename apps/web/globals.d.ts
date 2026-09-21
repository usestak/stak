// Allow side-effect imports of global stylesheets in the tsc-only typecheck
// (Next.js handles these at build time).
declare module '*.css';
