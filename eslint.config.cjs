const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['.local/**', 'node_modules/**', 'dist/**', 'artifacts/**', 'web-ext-artifacts/**', 'extension/vendor/**'] },
  {
    files: ['extension/**/*.js', 'browser-hosts/**/*.js', 'scripts/**/*.cjs', 'tests/**/*.cjs', 'eslint.config.cjs'],
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['extension/**/*.js', 'browser-hosts/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly', browser: 'readonly', MendoDiagnostics: 'readonly' } },
  },
  { files: ['extension/background.js', 'extension/mux_worker.js'], languageOptions: { globals: globals.worker } },
  { files: ['extension/offscreen.js'], languageOptions: { globals: { FFmpegWASM: 'readonly', MendoMediaPlan: 'readonly', reportError: 'off' } } },
  { files: ['extension/platform.js'], languageOptions: { globals: { MendoHostBackend: 'readonly' } } },
  { files: ['extension/background.js'], languageOptions: { globals: { MendoProcessorHost: 'readonly' } } },
  { files: ['extension/content_hook.js'], languageOptions: { globals: { MendoCaptions: 'readonly' } } },
  { files: ['extension/content_ui.js'], languageOptions: { globals: { MendoMenu: 'readonly', MendoMediaPlan: 'readonly' } } },
  { files: ['extension/captions.js', 'extension/media_plan.js', 'extension/menu.js', 'extension/diagnostics.js'], languageOptions: { globals: { module: 'readonly' } } },
  { files: ['scripts/**/*.cjs', 'tests/**/*.cjs', 'eslint.config.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
];
