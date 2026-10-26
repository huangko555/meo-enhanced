import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
const { createPointerDriver, findActiveWebview, NativeInputCapabilityError } = require('./native-input-delivery.cjs');

const allowed = new Set(['--browser-url', '--heading', '--selector', '--output', '--dx']);
const args = new Map(process.argv.slice(2).map(value => {
  const split = value.indexOf('=');
  assert.ok(split > 0 && allowed.has(value.slice(0, split)) && value.slice(split + 1), `Unknown or incomplete argument: ${value}`);
  return [value.slice(0, split), value.slice(split + 1)];
}));
if (args.has('--browser-url')) {
  const heading = args.get('--heading'), selector = args.get('--selector'), output = args.get('--output');
  assert.ok(heading && selector && output, 'Use --browser-url=... --heading=... --selector=... --output=... [--dx=24]');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(args.get('--browser-url')!).hostname), 'A local acceptance browser is required');
  if (args.has('--dx')) assert.ok(Number.isFinite(Number(args.get('--dx'))), 'Drag distance must be finite');
  const browser = await puppeteer.connect({ browserURL: args.get('--browser-url'), defaultViewport: null });
  const result: any = { passed: false, scope: 'Browser-protocol pointer delivery; not OS input or full installed-VSIX acceptance' };
  try {
    const { frame, page } = await findActiveWebview(browser, heading);
    result.frameUrl = frame.url();
    const driver = await createPointerDriver({ frame, page });
    result.delivery = args.has('--dx') ? await driver.drag(selector, Number(args.get('--dx'))) : await driver.click(selector);
    result.passed = true;
  } catch (error: any) {
    result.code = error.code; result.stage = error.stage; result.delivery = error.evidence; result.error = String(error);
    throw error;
  } finally {
    browser.disconnect();
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
  }
} else {
  assert.equal(args.size, 0, 'Native attachment arguments require --browser-url');
  const content = `<main class="editor-root"><div class="editor-host"><button id="click">Input token</button>
    <div id="drag" style="position:absolute;left:40px;top:90px;width:20px;height:40px;background:blue"></div></div></main>
    <script>window.clicks=0;document.getElementById('click').onclick=()=>window.clicks++;
    let dragging=false,start=0;document.getElementById('drag').onpointerdown=e=>{dragging=true;start=e.clientX;};
    onpointermove=e=>{if(dragging)document.getElementById('drag').style.width=(20+e.clientX-start)+'px';};
    onpointerup=()=>dragging=false;</script>`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/webview') return new Response(`<style>body{margin:0}iframe{position:absolute;inset:0;border:0;width:100%;height:100%}</style>
      <iframe id="active-frame" srcdoc="${content.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
    return new Response(`<style>body{margin:0}iframe{position:absolute;left:100px;top:60px;width:500px;height:350px;border:0}</style>
      <iframe src="/webview?id=contract"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('#drag'));
    const { frame } = await findActiveWebview(browser, 'Input token');
    const driver = await createPointerDriver({ frame, page });
    const clicked = await driver.click('#click');
    assert.equal(await frame.evaluate(() => (window as any).clicks), 1);
    assert.ok(clicked.events.some((event: any) => event.type === 'pointerdown' && event.trusted));
    const dragged = await driver.drag('#drag', 30);
    assert.equal(await frame.$eval('#drag', node => node.getBoundingClientRect().width), 50);
    assert.ok(dragged.events.some((event: any) => event.type === 'pointerup' && event.trusted));

    let presses = 0, releases = 0;
    const dropped = await createPointerDriver({ frame, page, timeoutMs: 150, mouse: {
      move: (...args: any[]) => (page.mouse.move as any)(...args),
      down: async () => { presses++; }, up: async () => { releases++; }
    } });
    await assert.rejects(dropped.drag('#drag', 30), (error: any) => error instanceof NativeInputCapabilityError
      && error.stage === 'pointerdown' && error.evidence.commands.includes('press acknowledged'));
    assert.equal(presses, 1, 'An acknowledged but undelivered press must not be retried');
    assert.equal(releases, 1, 'A failed press must still attempt release');
    assert.equal(await frame.$eval('#drag', node => node.getBoundingClientRect().width), 50);
    assert.equal(await frame.evaluate(() => '__meoInputDelivery' in window), false, 'Failure must remove its observer');

    const retargeted = await createPointerDriver({ frame, page, timeoutMs: 150, mouse: {
      move: (...args: any[]) => (page.mouse.move as any)(...args),
      down: async () => {
        await frame.evaluate(() => {
          const cover = document.createElement('div'); cover.id = 'late-cover';
          cover.style.cssText = 'position:fixed;inset:0;background:transparent;z-index:5'; document.body.append(cover);
        });
        await page.mouse.down();
      },
      up: () => page.mouse.up()
    } });
    try {
      await assert.rejects(retargeted.click('#click'), (error: any) => error.stage === 'pointerdown'
        && error.evidence.events.some((event: any) => event.type === 'pointerdown' && event.trusted && !event.targetMatches));
      assert.equal(await frame.evaluate(() => (window as any).clicks), 1, 'A different target must not count as the intended click');
    } finally { await frame.evaluate(() => document.getElementById('late-cover')?.remove()); }

    await frame.evaluate(() => { window.frameElement!.id = 'pending-frame'; });
    await assert.rejects(findActiveWebview(browser, 'Input token'), /Exactly one active Webview/);
    await frame.evaluate(() => { window.frameElement!.id = 'active-frame'; });
    await page.evaluate(() => {
      const cover = document.createElement('div'); cover.id = 'cover';
      cover.style.cssText = 'position:fixed;inset:0;background:black;z-index:5'; document.body.append(cover);
    });
    await assert.rejects(driver.click('#click'), (error: any) => error.stage === 'target');
    console.log('Native input delivery contract passed: actual press/move/release, dropped-command negative control, active frame, covering and cleanup');
  } catch (error) { primaryError = error; throw error; }
  finally {
    try {
      if (primaryError === undefined) await closeTestBrowser(browser);
      else await closeTestBrowser(browser, primaryError);
    } finally { server.stop(true); }
  }
}
