#!/usr/bin/env node
/**
 * Activates the repo's tracked git hooks by pointing git at
 * scripts/git-hooks. Runs from `npm install` (via the postinstall hook).
 *
 * Safe to run multiple times — `git config` is idempotent.
 * Safe to run outside a git repo — skips silently.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

if (!existsSync(resolve(repoRoot, '.git'))) {
  // Not a git checkout — could be running inside the asar bundle, a tarball
  // install, or CI without git. Nothing to do.
  process.exit(0);
}

const hooksDir = resolve(repoRoot, 'scripts/git-hooks');
if (!existsSync(hooksDir)) {
  console.log('[setup-git-hooks] no scripts/git-hooks dir — skipping');
  process.exit(0);
}

// Make every hook in the directory executable. git refuses to run a hook
// that isn't +x, and "git add" preserves the bit only if it's set before
// staging — but we'd rather be belt-and-braces.
for (const f of readdirSync(hooksDir)) {
  if (f.startsWith('.')) continue;
  try { chmodSync(join(hooksDir, f), 0o755); } catch { /* best-effort */ }
}

const r = spawnSync('git', ['config', 'core.hooksPath', 'scripts/git-hooks'], {
  cwd: repoRoot,
  stdio: 'inherit'
});
if (r.status === 0) {
  console.log('[setup-git-hooks] core.hooksPath → scripts/git-hooks');
}
process.exit(r.status ?? 0);
