import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;

function build() {
  const out = mkdtempSync(join(tmpdir(), 'c8-chat-package-'));
  execFileSync(process.execPath, [join(ROOT, 'scripts/package.mjs')], {
    cwd: ROOT,
    env: { ...process.env, C8_DIST: out },
    stdio: 'pipe',
  });
  return out;
}

function readZip(path) {
  return unzipSync(new Uint8Array(readFileSync(path)));
}

test('package.mjs writes the versioned and stable artifacts and SHA256SUMS', () => {
  const out = build();
  try {
    for (const name of [
      `c8-chat-${VERSION}-chrome.zip`,
      'c8-chat-chrome.zip',
      `c8-chat-${VERSION}-firefox-unsigned.xpi`,
      'c8-chat-firefox-unsigned.xpi',
      `c8-chat-${VERSION}-source.zip`,
      'c8-chat-source.zip',
      'SHA256SUMS',
    ]) {
      assert.ok(existsSync(join(out, name)), `${name} exists`);
    }
    const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
    assert.equal(sums.length, 6);
    assert.ok(sums.every((line) => /^[0-9a-f]{64}  c8-chat-/.test(line)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('extension archives have manifest.json at the root and only extension files', () => {
  const out = build();
  try {
    for (const name of [`c8-chat-${VERSION}-chrome.zip`, `c8-chat-${VERSION}-firefox-unsigned.xpi`]) {
      const entries = readZip(join(out, name));
      const names = Object.keys(entries);
      assert.ok(names.includes('manifest.json'), `${name} has manifest.json at root`);
      for (const forbidden of ['test/', 'store/', 'scripts/', 'docs/', 'node_modules/', '.git/', 'README', 'LICENSE', 'package.json']) {
        assert.ok(!names.some((entry) => entry === forbidden || entry.startsWith(forbidden)), `${name} excludes ${forbidden}`);
      }
      assert.ok(names.includes('src/panel.js'));
      assert.ok(names.includes('src/panel.css'));
      assert.ok(names.includes('icons/icon-128.png'));
      assert.ok(!names.includes('icons/icon.svg'));
      const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'));
      assert.equal(manifest.version, VERSION);
      assert.equal(manifest.name, 'C8 Chat');
      assert.equal(manifest.action.default_popup, undefined);
      const background = manifest.background;
      if (name.endsWith('-chrome.zip')) {
        assert.equal(background.service_worker, 'src/background.js');
        assert.equal(background.scripts, undefined);
      } else {
        assert.deepEqual(background.scripts, ['src/background.js']);
        assert.equal(background.service_worker, undefined);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('source archive includes the reproduction instructions and tests', () => {
  const out = build();
  try {
    const entries = readZip(join(out, `c8-chat-${VERSION}-source.zip`));
    const names = Object.keys(entries);
    assert.ok(names.includes('README-BUILD.md'));
    assert.ok(names.includes('test/package.test.mjs'));
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('package.json'));
    assert.ok(names.includes('src/panel.js'));
    assert.ok(names.includes('icons/icon.svg'));
    assert.ok(!names.some((entry) => entry.startsWith('dist/') || entry.startsWith('node_modules/') || entry.startsWith('store/')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
