#!/usr/bin/env node
// Verify the manifest, package.json, CHANGELOG, and an optional release tag agree.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

const tag = process.argv[2] || '';
const tagVersion = tag.replace(/^v/, '');

function fail(message) {
  console.error(`version: ${message}`);
  process.exit(1);
}

if (manifest.version !== pkg.version) {
  fail(`manifest ${manifest.version} != package.json ${pkg.version}`);
}
if (tagVersion && tagVersion !== manifest.version) {
  fail(`tag ${tag} != manifest ${manifest.version}`);
}
if (!new RegExp(`^## \\[?${manifest.version.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
  fail(`CHANGELOG.md has no ${manifest.version} section`);
}

console.log(`version OK: ${manifest.version}${tag ? ` (tag ${tag})` : ''}`);
