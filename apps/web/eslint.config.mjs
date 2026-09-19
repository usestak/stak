import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.next/**', 'dist/**', 'next-env.d.ts', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Minimal web app; allow pragmatic any at the Supabase boundary.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
