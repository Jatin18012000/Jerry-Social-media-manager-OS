/**
 * The rule that keeps PRD §65 true: domain and port code may not import an
 * adapter, a framework, or the database. If that boundary is enforced only by
 * discipline it will erode, so it is enforced by lint.
 *
 * Deliberately dependency-light — this config exists to protect one
 * architectural invariant, not to impose a general style regime.
 */
import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'next-env.d.ts',
      'data/**',
    ],
  },
  {
    files: ['src/domain/**/*.ts', 'src/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/db',
                '@/db/*',
                '@/adapters',
                '@/adapters/*',
                '@/app',
                '@/app/*',
                'next',
                'next/*',
                'react',
                'react-dom',
                'drizzle-orm',
                'drizzle-orm/*',
                'better-sqlite3',
              ],
              message:
                'PRD §65: domain and port code must not depend on adapters, ' +
                'a framework, or a driver. Define or use a port instead.',
            },
          ],
        },
      ],
    },
  },
];
