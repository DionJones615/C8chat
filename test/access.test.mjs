import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/access.js', import.meta.url), 'utf8');

function setup(options) {
  const opts = options || {};
  const handlers = {};
  const status = { textContent: '' };
  const button = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  const created = [];
  const opened = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.9.50' }) },
    tabs: { create: (info) => { created.push(info); } }
  };
  if (opts.noTabs) delete chrome.tabs;
  vm.runInContext(src, vm.createContext({
    document: { getElementById: (id) => (id === 'status' ? status : button) },
    window: { open: (url, target) => { opened.push([url, target]); } },
    chrome
  }));
  return { status, created, opened, click: () => handlers.click({}) };
}

test('reports the installed version and tells the user to reload the game tab', () => {
  const env = setup();
  assert.equal(env.status.textContent,
    'C8 Chat 0.9.50 is installed. Open Castle Infinity and reload the tab; ' +
    'the chat panel appears on the page. Use Settings, then Panel, to dock it ' +
    'left or right, or leave it floating.');
});

test('the button opens Castle Infinity in a tab', () => {
  const env = setup();
  env.click();
  // a URL object made inside the vm has another realm's prototype
  assert.equal(JSON.stringify(env.created), JSON.stringify([{ url: 'https://www.castleinfinity.com/' }]));
  assert.deepEqual(env.opened, []);
});

test('the button falls back to window.open without the tabs API', () => {
  const env = setup({ noTabs: true });
  env.click();
  assert.deepEqual(env.opened, [['https://www.castleinfinity.com/', '_blank']]);
  assert.deepEqual(env.created, []);
});
