import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', '*.tsbuildinfo'] },

  js.configs.recommended,

  // Type-aware, because the rules that matter most here need types: an unawaited promise in the
  // main process is a silently swallowed failure, and this codebase is full of deliberate
  // fire-and-forget calls that must be marked as such.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // React props and DOM handlers legitimately take async callbacks.
        { checksVoidReturn: false }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // The Gmail and Gemini response types are full of optionals that are non-null in practice
      // and already guarded by a filter on the line above.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tool handlers and IPC handlers are typed as returning a promise by their interface, so
      // the simple ones are legitimately async with nothing to await.
      '@typescript-eslint/require-await': 'off'
    }
  },

  // Build tooling that sits outside both tsconfigs, so there are no types to check against.
  {
    files: ['eslint.config.mjs', 'electron.vite.config.ts', 'scripts/**'],
    ...tseslint.configs.disableTypeChecked
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    // `configs.flat` — the top-level key of the same name is still eslintrc-shaped.
    ...reactHooks.configs.flat['recommended-latest']
  },

  // Worklets run in a scope with no DOM and their own globals, declared ambiently.
  {
    files: ['src/renderer/audio/*.worklet.ts'],
    rules: { 'no-undef': 'off' }
  },

  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    // Plain JS gets no types, so `no-undef` needs to be told what Node provides.
    languageOptions: { globals: globals.node }
  }
)
