#!/usr/bin/env node
// Headless Chromium smoke test for C8 Chat.
//
// No Selenium or Playwright package is needed: Chromium exposes the DevTools
// protocol and Node 22+ has a global WebSocket. This loads dist/unpacked, opens
// the game, checks the injected panel, exercises floating/dock-left/dock-right,
// and writes screenshots under dist/.
//
// CHROME_BIN overrides the cached Playwright Chromium binary. EXT_DIR overrides
// the unpacked extension directory. The script always uses a throwaway profile
// and kills only the browser it started.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = 'https://www.castleinfinity.com/';
const PORT = Number(process.env.CDP_PORT || 9333);
const EXT = resolve(process.env.EXT_DIR || join(ROOT, 'dist', 'unpacked'));
const CHROME = resolve(process.env.CHROME_BIN || join(process.env.HOME || '', '.cache', 'ms-playwright', 'chromium-1243', 'chrome-linux64', 'chrome'));
const PROFILE = mkdtempSync(join(tmpdir(), 'c8-chat-smoke-'));
const OUT = join(ROOT, 'dist');

let child = null;
let stderr = '';
let cdp = null;

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchJson(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* browser not listening yet */ }
    if (child && child.exitCode !== null) {
      fail(`Chromium exited before CDP was ready (code ${child.exitCode}). stderr:\n${stderr.slice(-3000)}`);
    }
    await delay(200);
  }
  fail(`CDP did not become ready at ${url}. stderr:\n${stderr.slice(-3000)}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      fail(`page evaluation failed: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description || expression}`);
    }
    return result.result ? result.result.value : undefined;
  }
}

async function waitFor(expression, label, timeoutMs = 90000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      if (await cdp.eval(expression)) return;
    } catch (error) {
      lastError = error.message;
    }
    await delay(500);
  }
  const state = await cdp.eval('({ title: document.title, href: location.href, body: (document.body || {}).innerText?.slice(0, 500) })').catch(() => null);
  fail(`timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}\nstate: ${JSON.stringify(state)}`);
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot ${path}`);
}

async function main() {
  if (!existsSync(join(EXT, 'manifest.json'))) fail(`no manifest at ${EXT}; run "npm run package:unpacked" first`);
  if (!existsSync(CHROME)) fail(`Chromium not found at ${CHROME}; set CHROME_BIN to a Chromium binary`);
  mkdirSync(OUT, { recursive: true });

  child = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) fail(`no page target: ${JSON.stringify(targets)}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener('error', () => rejectPromise(new Error('CDP WebSocket failed')), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: GAME });

  await waitFor('document.readyState !== "loading"', 'the game page to load');
  await waitFor('!!(document.querySelector("#c8-chat-host")?.shadowRoot?.getElementById("panel"))', 'the panel host');

  const visibleExpr = '!document.querySelector("#c8-chat-host").shadowRoot.getElementById("panel").classList.contains("hidden")';
  let open = await cdp.eval(visibleExpr);
  if (!open) {
    await cdp.eval('document.querySelector("#c8-chat-host").shadowRoot.getElementById("toggle").click()');
    await delay(500);
    open = await cdp.eval(visibleExpr);
  }
  if (!open) fail('the panel is not visible and the launcher did not open it');

  // The launcher toggles hide/show; verify both directions, then leave it open.
  await cdp.eval('document.querySelector("#c8-chat-host").shadowRoot.getElementById("toggle").click()');
  await delay(300);
  if (await cdp.eval(visibleExpr)) fail('the launcher did not hide the panel');
  await cdp.eval('document.querySelector("#c8-chat-host").shadowRoot.getElementById("toggle").click()');
  await delay(300);
  if (!(await cdp.eval(visibleExpr))) fail('the launcher did not reopen the panel');
  await screenshot('smoke-float.png');

  await cdp.eval('document.querySelector("#c8-chat-host").shadowRoot.getElementById("cog").click()');
  await delay(400);
  for (const side of ['right', 'left']) {
    const clicked = await cdp.eval(`(() => { const r = document.querySelector("#c8-chat-host").shadowRoot; const b = r.getElementById("dock-${side}"); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) fail(`missing dock-${side} control`);
    await delay(800);
    const docked = await cdp.eval(`document.querySelector("#c8-chat-host").shadowRoot.getElementById("panel").classList.contains("dock-${side}")`);
    if (!docked) fail(`panel did not enter dock-${side}`);
    await screenshot(`smoke-dock-${side}.png`);
  }
  const floated = await cdp.eval('(() => { const r = document.querySelector("#c8-chat-host").shadowRoot; const b = r.getElementById("dock-float"); if (!b) return false; b.click(); return true; })()');
  if (!floated) fail('missing dock-float control');
  await delay(500);

  console.log('CHROMIUM SMOKE PASSED: host, panel, launcher, Settings, floating, dock-right, dock-left');
}

try {
  await main();
} catch (error) {
  console.error(`CHROMIUM SMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { if (cdp && cdp.ws) cdp.ws.close(); } catch { /* ignore */ }
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await delay(1000);
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  rmSync(PROFILE, { recursive: true, force: true });
}
