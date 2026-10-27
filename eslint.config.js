import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Node-run test helper scripts (spawned as child processes, not imported
    // by the package itself), evaluated against Node's global scope.
    files: ['packages/*/src/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: [
      'packages/core/**/*.ts',
      'packages/scanner/**/*.ts',
      'packages/adapters/**/*.ts',
      'packages/spec/**/*.ts',
      'packages/store/**/*.ts',
      'packages/shared/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@usestak/cli',
                '@stack/web',
                'react',
                'react/**',
                'next',
                'next/**',
                '@supabase/**',
              ],
              message:
                'Domain and infrastructure packages must not depend on CLI, web, React, Next.js, or Supabase concerns.',
            },
          ],
        },
      ],
    },
  },
);
