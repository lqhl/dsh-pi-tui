// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  // Ignore build output and dependencies.
  { ignores: ['lib/**', 'node_modules/**', 'eslint.config.mjs'] },

  // Base recommended + type-aware recommended rules.
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Explicit project (src + test) so type-aware rules cover both.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Leading-underscore params/vars are intentionally unused (theme
      // callbacks mirror an interface signature).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Test files: top-level `test()` and mock helpers legitimately don't
  // await; stripAnsi helpers match control characters. Relax those rules
  // without losing the rest of the type-aware checks.
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-control-regex': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Disable formatting rules that conflict with Prettier (must be last).
  eslintConfigPrettier,
)
