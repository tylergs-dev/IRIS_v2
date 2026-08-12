import { VelopackApp } from 'velopack'

/**
 * Velopack's startup hooks must run before anything else in the process.
 *
 * On install, update, and uninstall, Velopack re-launches this very executable with `--veloapp-*`
 * arguments; `run()` handles the hook and then exits the process from inside itself. Anything that
 * executes before it therefore runs again on every install and every update — creating windows,
 * registering shortcuts, opening the profile store — and some of that would fail or corrupt state
 * in an environment where no user is present.
 *
 * "First statement in main" cannot be expressed literally in a bundled app, because a bundler
 * hoists every import above the first statement of the entry file. So it lives here instead, as a
 * module with a side effect, imported first by `main/index.ts`: Rollup preserves the evaluation
 * order of side-effecting imports, which makes this the first application code in the process.
 * Nothing else may be imported by this file beyond Velopack itself.
 */
try {
  VelopackApp.build()
    // Left on (the default): a downloaded update is applied at the next natural restart with no
    // interaction at all, which is the quietest possible path for someone who cannot see a dialog.
    .setAutoApplyOnStartup(true)
    .run()
} catch (error) {
  // Thrown on every development run, where the app is not a Velopack install. Logged with
  // console because the logger imports the rest of the app, which must not load yet.
  console.warn('[velopack] startup hook skipped:', error instanceof Error ? error.message : error)
}
