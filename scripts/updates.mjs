#!/usr/bin/env node
// Generate or check docs/updates.json for the Firefox unlisted release.
//
// The update manifest points at the versioned signed XPI. Pass --xpi=<file> to
// add an integrity hash; without it the HTTPS release URL is the verification.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const gecko = manifest.browser_specific_settings.gecko;
const version = manifest.version;
const updateUrl = gecko.update_url || '';
const file = join(ROOT, 'docs', 'updates.json');

function fail(message) {
  console.error(`updates: ${message}`);
  process.exit(1);
}

if (!/^https:\/\/\S+\/updates\.json$/.test(updateUrl)) {
  fail('manifest gecko.update_url must be an HTTPS updates.json URL');
}
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail('manifest version is not valid');

const link = `https://github.com/DionJones615/C8chat/releases/download/v${version}/c8-chat-${version}-firefox-signed.xpi`;
const update = {
  version,
  update_link: link,
  applications: { gecko: { strict_min_version: gecko.strict_min_version } },
};

const xpiArg = process.argv.find((arg) => arg.startsWith('--xpi='));
if (xpiArg) {
  const xpi = resolve(xpiArg.slice('--xpi='.length));
  const hash = createHash('sha256').update(readFileSync(xpi)).digest('hex');
  update.update_hash = `sha256:${hash}`;
}

const wanted = { addons: { [gecko.id]: { updates: [update] } } };

if (process.argv.includes('--check')) {
  const actual = JSON.parse(readFileSync(file, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`docs/updates.json is stale for ${version}`);
  }
  console.log(`updates OK: ${gecko.id} ${version}`);
} else {
  writeFileSync(file, `${JSON.stringify(wanted, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
