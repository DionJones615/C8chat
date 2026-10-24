import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('docs/updates.json matches the manifest and signed release URL', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'scripts/updates.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /updates OK/);
});
