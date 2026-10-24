import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const SITE = 'https://www.castleinfinity.com/';

// Objects made inside the vm have another realm's prototypes, so compare JSON.
function setup(tabs) {
  const calls = [];
  let listener;
  const browser = {
    action: { onClicked: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      query: async () => tabs,
      update: async (id, props) => { calls.push(['update', id, props]); },
      create: async (props) => { calls.push(['create', props.url]); }
    },
    windows: { update: async (id, props) => { calls.push(['window', id, props.focused]); } }
  };
  vm.runInContext(src, vm.createContext({ browser }));
  return { calls, click: () => listener() };
}

test('the toolbar button focuses a tab that already has the game', async () => {
  const env = setup([{ id: 7, windowId: 2, url: SITE + 'play/' }]);
  await env.click();
  assert.equal(JSON.stringify(env.calls),
    JSON.stringify([['update', 7, { active: true }], ['window', 2, true]]));
});

test('the toolbar button opens the game in a new tab when none is open', async () => {
  const env = setup([{ id: 3, windowId: 1, url: 'https://example.com/' }, { id: 4, windowId: 1 }]);
  await env.click();
  assert.equal(JSON.stringify(env.calls), JSON.stringify([['create', SITE]]));
});
