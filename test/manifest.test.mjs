import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function pngSize(path) {
  const data = readFileSync(path);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path} is a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test('manifest is C8 Chat, versioned consistently, with an accurate short description', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'C8 Chat');
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 132);
  assert.match(manifest.description, /Unofficial/);
  assert.doesNotMatch(manifest.description, /inventory|routine|macro/i);
});

test('manifest declares the icons the stores require and they are the right size', () => {
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(manifest.icons && manifest.icons[size], `icons.${size}`);
    const file = join(ROOT, manifest.icons[size]);
    assert.ok(existsSync(file), `${manifest.icons[size]} exists`);
    const actual = pngSize(file);
    assert.equal(actual.width, Number(size));
    assert.equal(actual.height, Number(size));
  }
  assert.equal(manifest.action.default_title, 'C8 Chat');
  for (const file of Object.values(manifest.action.default_icon)) {
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
  }
});

test('manifest uses minimum permissions and no private-browsing storage', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://www.castleinfinity.com/*']);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
});

test('manifest is a valid Firefox MV3 add-on with the data declaration', () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.match(gecko.id, /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/);
  assert.ok(Number.parseFloat(gecko.strict_min_version) >= 140);
  assert.deepEqual(gecko.data_collection_permissions.required, ['none']);
  assert.equal(gecko.data_collection_permissions.optional, undefined);
});

test('content scripts and web-accessible resources point at real files', () => {
  const scripts = manifest.content_scripts;
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0].world, 'MAIN');
  assert.equal(scripts[0].run_at, 'document_start');
  assert.equal(scripts[1].world, 'ISOLATED');
  assert.equal(scripts[1].run_at, 'document_idle');
  for (const group of scripts) {
    for (const file of group.js) assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
  }
  for (const group of manifest.web_accessible_resources) {
    for (const file of group.resources) assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
    assert.deepEqual(group.matches, ['https://www.castleinfinity.com/*']);
  }
});

test('the player feed uses an absolute URL and the embedded game art is gone', () => {
  const panel = readFileSync(join(ROOT, 'src/panel.js'), 'utf8');
  assert.match(panel, /fetch\('https:\/\/www\.castleinfinity\.com\/api\/players'/);
  assert.doesNotMatch(panel, /fetch\('\/api\/players'/);
  const css = readFileSync(join(ROOT, 'src/panel.css'), 'utf8');
  assert.doesNotMatch(css, /data:image\/png;base64/);
});

test('source does not use dynamic code', () => {
  for (const file of readdirSync(join(ROOT, 'src'))) {
    const text = readFileSync(join(ROOT, 'src', file), 'utf8');
    assert.doesNotMatch(text, /\beval\s*\(|\bnew Function\b|\bimportScripts\s*\(/, file);
  }
});

test('the old display name and host id are gone from user-facing files', () => {
  const files = ['manifest.json', 'README.md', 'AGENTS.md', 'src/access.html', 'src/access.js', 'src/panel.js', 'src/agent.js', 'src/protocol.js', 'src/panel.css'];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /Castle Companion|c8-companion-host|c8-companion@localhost/, file);
  }
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /^# C8 Chat/m);
  assert.match(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), /^# C8 Chat/m);
});
