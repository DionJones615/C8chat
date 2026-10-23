#!/usr/bin/env node
// Package C8 Chat for the Chrome Web Store, Firefox AMO, and source review.
//
// There is no build step: this script only validates the manifest, stages the
// exact extension files, and writes deterministic ZIP/XPI archives. The source
// archive is the same repository plus README-BUILD.md so an AMO reviewer can
// reproduce what was uploaded.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(process.env.C8_DIST || join(ROOT, 'dist'));
const UNPACKED = join(DIST, 'unpacked');
const MTIME = new Date('2026-01-01T00:00:00Z');
const EXTENSION_PREFIXES = ['src/', 'icons/'];
const SOURCE_ROOTS = [
  '.editorconfig', '.gitattributes', '.gitignore',
  'AGENTS.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md',
  'LICENSE', 'PRIVACY.md', 'PUBLISHING.md', 'README.md', 'README-BUILD.md',
  'SECURITY.md', 'manifest.json', 'package.json', 'package-lock.json',
  'docs', 'icons', 'scripts', 'src', 'test',
];

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relative(ROOT, path)} is not valid JSON: ${error.message}`);
  }
}

function walk(path) {
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function posix(path) {
  return path.split(sep).join('/');
}

function pngSize(path) {
  const data = readFileSync(path);
  const signature = '89504e470d0a1a0a';
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== signature) {
    fail(`${relative(ROOT, path)} is not a PNG`);
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function validateManifest(manifest, pkg) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (manifest.name !== 'C8 Chat') fail('manifest name must be "C8 Chat"');
  if (manifest.version !== pkg.version) fail('manifest version and package.json version differ');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail('manifest version is not a valid extension version');
  if (!manifest.description || manifest.description.length > 132) fail('description must be 1..132 characters');
  if (/(inventory|routine|macro)/i.test(manifest.description)) fail('description claims an unimplemented feature');
  if (manifest.incognito !== 'not_allowed') fail('incognito must be "not_allowed"');
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) fail('permissions must be exactly ["storage"]');
  const hosts = manifest.host_permissions || [];
  if (hosts.length !== 1 || hosts[0] !== 'https://www.castleinfinity.com/*') fail('host_permissions must be the single game origin');

  const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
  if (!gecko) fail('browser_specific_settings.gecko is required');
  if (!/^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/.test(gecko.id || '')) fail('gecko id is not email-like');
  if (Number.parseFloat(gecko.strict_min_version || '0') < 140) fail('strict_min_version must be at least 140 for data collection consent');
  const required = gecko.data_collection_permissions && gecko.data_collection_permissions.required;
  if (!Array.isArray(required) || !required.includes('none')) fail('data_collection_permissions.required must include "none"');

  if (!manifest.icons || !manifest.icons['128']) fail('icons.128 is required');
  for (const [size, file] of Object.entries(manifest.icons)) {
    const full = join(ROOT, file);
    if (!existsSync(full)) fail(`missing icon ${file}`);
    const actual = pngSize(full);
    if (actual.width !== Number(size) || actual.height !== Number(size)) {
      fail(`${file} is ${actual.width}x${actual.height}, expected ${size}x${size}`);
    }
  }
  const action = manifest.action || {};
  if (action.default_title !== 'C8 Chat') fail('action.default_title must be "C8 Chat"');
  if (!action.default_icon || !action.default_icon['16']) fail('action.default_icon.16 is required');
  for (const file of Object.values(action.default_icon)) {
    if (!existsSync(join(ROOT, file))) fail(`missing action icon ${file}`);
  }

  const scripts = manifest.content_scripts || [];
  for (const group of scripts) {
    for (const file of group.js || []) {
      if (!existsSync(join(ROOT, file))) fail(`missing content script ${file}`);
    }
  }
  for (const group of manifest.web_accessible_resources || []) {
    for (const file of group.resources || []) {
      if (!existsSync(join(ROOT, file))) fail(`missing web-accessible resource ${file}`);
    }
  }
}

function validateSources() {
  const panel = readFileSync(join(ROOT, 'src/panel.js'), 'utf8');
  if (!panel.includes('https://www.castleinfinity.com/api/players')) {
    fail('src/panel.js must fetch the player feed with an absolute URL');
  }
  if (panel.includes("fetch('/api/players'")) fail('src/panel.js still uses a relative player-feed URL');

  const css = readFileSync(join(ROOT, 'src/panel.css'), 'utf8');
  if (css.includes('data:image/png;base64')) fail('src/panel.css still embeds game art');

  for (const file of walk(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    if (/\beval\s*\(|\bnew Function\b|\bimportScripts\s*\(/.test(text)) {
      fail(`${relative(ROOT, file)} contains prohibited dynamic code`);
    }
  }
}

function extensionFiles() {
  const files = ['manifest.json'];
  for (const prefix of EXTENSION_PREFIXES) {
    for (const file of walk(join(ROOT, prefix))) {
      const rel = posix(relative(ROOT, file));
      if (rel.startsWith('icons/') && !rel.endsWith('.png')) continue;
      files.push(rel);
    }
  }
  return files;
}

function readEntries(relPaths) {
  const entries = {};
  for (const rel of relPaths) {
    entries[rel] = new Uint8Array(readFileSync(join(ROOT, rel)));
  }
  return entries;
}

function archive(entries) {
  return Buffer.from(zipSync(entries, { level: 9, mtime: MTIME }));
}

function verifyArchive(buffer, label, forbidden) {
  const entries = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(entries);
  if (!names.includes('manifest.json')) fail(`${label} does not have manifest.json at the root`);
  for (const name of names) {
    for (const prefix of forbidden) {
      if (name === prefix || name.startsWith(prefix)) fail(`${label} contains forbidden path ${name}`);
    }
  }
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'));
  return { names, manifest };
}

function writeArtifact(name, buffer) {
  const path = join(DIST, name);
  writeFileSync(path, buffer);
  const hash = createHash('sha256').update(buffer).digest('hex');
  console.log(`${hash}  ${name}  (${buffer.length} bytes)`);
  return { name, hash, size: buffer.length };
}

function sourceFiles() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    const full = join(ROOT, root);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      for (const file of walk(full)) {
        const rel = posix(relative(ROOT, file));
        if (rel.startsWith('store/') || rel.startsWith('dist/')) continue;
        files.push(rel);
      }
    } else {
      files.push(root);
    }
  }
  return [...new Set(files)].sort();
}

function main() {
  const manifest = readJson(join(ROOT, 'manifest.json'));
  const pkg = readJson(join(ROOT, 'package.json'));
  validateManifest(manifest, pkg);
  validateSources();

  const files = extensionFiles();
  for (const file of files) {
    if (!existsSync(join(ROOT, file))) fail(`missing extension file ${file}`);
  }

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(UNPACKED, { recursive: true });
  for (const rel of files) {
    const target = join(UNPACKED, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(ROOT, rel)));
  }
  console.log(`staged ${files.length} files in dist/unpacked`);

  if (process.argv.includes('--unpacked')) return;

  const version = manifest.version;
  const extensionEntries = readEntries(files);
  const chrome = archive(extensionEntries);
  const firefox = archive(extensionEntries);
  const chromeCheck = verifyArchive(chrome, 'chrome zip', ['test/', 'store/', 'scripts/', 'docs/', 'node_modules/', '.git/', 'README', 'LICENSE', 'package']);
  const firefoxCheck = verifyArchive(firefox, 'firefox xpi', ['test/', 'store/', 'scripts/', 'docs/', 'node_modules/', '.git/', 'README', 'LICENSE', 'package']);
  if (chromeCheck.manifest.version !== version || firefoxCheck.manifest.version !== version) fail('archive manifest version mismatch');

  const source = archive(readEntries(sourceFiles()));
  const sourceCheck = verifyArchive(source, 'source zip', ['dist/', 'node_modules/', '.git/', 'store/']);
  if (!sourceCheck.names.includes('README-BUILD.md')) fail('source zip must include README-BUILD.md');

  const results = [
    writeArtifact(`c8-chat-${version}-chrome.zip`, chrome),
    writeArtifact(`c8-chat-${version}-firefox.xpi`, firefox),
    writeArtifact(`c8-chat-${version}-source.zip`, source),
  ];
  writeFileSync(join(DIST, 'SHA256SUMS'), results.map((r) => `${r.hash}  ${r.name}`).join('\n') + '\n');
  console.log(`wrote ${results.length} artifacts and SHA256SUMS in dist/`);
}

main();
