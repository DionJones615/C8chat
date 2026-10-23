import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('repository documentation and community files are present', () => {
  for (const file of [
    'README.md', 'README-BUILD.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
    'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'PUBLISHING.md',
    'AGENTS.md', '.gitignore', '.gitattributes', '.editorconfig',
  ]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
  }
});

test('GitHub workflows, templates, and automation metadata are present', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/publish-stores.yml',
    '.github/dependabot.yml',
    '.github/pull_request_template.md',
    '.github/CODEOWNERS',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
  ]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
  }
  assert.match(read('.github/workflows/ci.yml'), /npm run check/);
  assert.match(read('.github/workflows/release.yml'), /tags:/);
  assert.match(read('.github/workflows/release.yml'), /gh release create/);
  assert.match(read('.github/workflows/publish-stores.yml'), /workflow_dispatch/);
  assert.match(read('.github/workflows/publish-stores.yml'), /environment:/);
});

test('README, changelog, license, and privacy policy carry the release facts', () => {
  const readme = read('README.md');
  assert.match(readme, /^# C8 Chat/m);
  assert.match(readme, /Unofficial/i);
  assert.match(readme, /Privacy/i);
  assert.match(readme, /Contributing/i);
  assert.match(readme, /License/i);
  assert.match(read('CHANGELOG.md'), /^## \[1\.0\.0\]/m);
  assert.match(read('LICENSE'), /MIT License/);
  assert.match(read('PRIVACY.md'), /C8 Chat/);
  assert.match(read('PRIVACY.md'), /chrome\.storage\.local/);
  assert.match(read('PRIVACY.md'), /Limited Use/);
  assert.match(read('CONTRIBUTING.md'), /npm run check/);
  assert.match(read('SECURITY.md'), /GitHub/);
});

test('ignore rules keep build products and caches out of git', () => {
  const ignore = read('.gitignore');
  for (const entry of ['dist/', 'node_modules/', '.tmp/', '*.xpi', '*.zip']) {
    assert.ok(ignore.includes(entry), `.gitignore includes ${entry}`);
  }
});
