import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';

const text = '# 预览加载体验\n\n' + Array.from({ length: 2_200 }, (_, i) =>
  `## 第 ${i + 1} 节\n\n这是用于检查预览加载的正文，包含 **强调**、[链接](https://example.test) 和阅读位置。\n\n`).join('');
fs.mkdirSync('.local/preview-loading', { recursive: true });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function exercise(side: boolean) {
  const page = await browser.newPage();
  const host = await open(page, text, false, 'source', { uiLanguage: 'zh-CN' });
  const trigger = side ? '.source-preview-button' : '[data-mode="preview"]';
  const shown = () => page.evaluate(() => {
    const e = document.querySelector<HTMLElement>('.preview-loading');
    return !!e && !e.hidden && getComputedStyle(e).visibility === 'visible';
  });
  const gate = async (fail = false) => page.evaluate(fail => {
    const scope = window as any;
    scope.__loadingHold = true; scope.__loadingFail = fail; scope.__loadingEntered = false;
    if (scope.__loadingOriginalHost) return;
    scope.__loadingOriginalHost = scope.__presentationHost;
    scope.__presentationHost = async (message: any) => {
      if (message.type === 'requestPreviewRender' && scope.__loadingHold) {
        scope.__loadingEntered = true;
        await new Promise(resolve => { scope.__loadingRelease = resolve; });
        if (scope.__loadingFail) return { type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: false, error: { code: 'operation-failed', message: 'Controlled render failure' } } };
      }
      return scope.__loadingOriginalHost(message);
    };
    scope.__loadingShows = [];
    document.addEventListener('click', event => {
      if ((event.target as Element)?.closest('.source-preview-button, [data-mode="preview"]')) scope.__loadingStart = performance.now();
    }, true);
    new MutationObserver(() => {
      const e = document.querySelector<HTMLElement>('.preview-loading');
      if (e && !e.hidden) scope.__loadingShows.push(performance.now());
    }).observe(document.querySelector('.preview-host')!, { attributes: true, subtree: true });
  }, fail);
  const release = async () => page.evaluate(() => {
    const scope = window as any; scope.__loadingHold = false; scope.__loadingRelease?.();
  });
  const ready = () => page.waitForFunction(() => {
    const p = document.querySelector<HTMLElement>('.preview-host')!;
    const l = p.querySelector<HTMLElement>('.preview-loading');
    return l?.hidden && !p.inert && getComputedStyle(p).visibility === 'visible'
      && !!p.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.querySelector('main.meo-export-doc');
  });
  try {
    await gate(); await page.click(trigger);
    await page.waitForFunction(() => (window as any).__loadingEntered);
    assert.equal(await shown(), false, 'The first feedback must remain silent below the threshold');
    await page.waitForFunction(() => {
      const e = document.querySelector<HTMLElement>('.preview-loading');
      return e && !e.hidden && getComputedStyle(e).visibility === 'visible';
    }, { timeout: 2_000 });
    const state = await page.evaluate(() => {
      const scope = window as any, e = document.querySelector<HTMLElement>('.preview-loading')!;
      const editor = document.querySelector<HTMLElement>('.editor-host')!;
      return { elapsed: scope.__loadingShows[0] - scope.__loadingStart, text: e.textContent,
        editorCovered: editor.hasAttribute('data-preview-cover'), editorInert: editor.inert,
        frameInert: document.querySelector<HTMLElement>('.preview-frame')!.inert };
    });
    assert.ok(state.elapsed >= 195 && state.elapsed < 1_000, JSON.stringify(state));
    assert.match(state.text!, /正在加载预览/);
    assert.equal(state.frameInert, true, 'An unfinished frame must not become interactive');
    if (side) assert.equal(state.editorInert, false, 'Loading the side Preview must not block editing');
    else assert.equal(state.editorCovered, false, 'A slow Preview must replace the frozen-looking editor cover');
    await page.mouse.move(2, 2); await delay(180); await frames(page);
    await page.screenshot({ path: `.local/preview-loading/${side ? 'side' : 'full'}-dark.png` });
    if (side) {
      await page.click('.editor-host .cm-line'); await page.keyboard.press('End'); await page.keyboard.type('123');
      assert.equal(await shown(), true, 'Source input must work while initial Preview remains pending');
    }
    await release(); await ready();
    assert.equal(await shown(), false, 'Ready content must replace loading immediately');
    if (side) assert.match(await page.$eval('.preview-frame', e => (e as HTMLIFrameElement).contentDocument!
      .querySelector('h1')!.textContent!), /123$/, 'Initial loading must publish the latest edited Draft');

    // Editing is deliberately slow here, but must remain completely silent.
    if (side) {
      await gate(); await page.click('.editor-host .cm-line'); await page.keyboard.type('123');
      await page.waitForFunction(() => (window as any).__loadingEntered);
      await delay(350); assert.equal(await shown(), false, 'Editing must never show loading feedback');
      await release(); await delay(350); await frames(page);
    }

    // A warm reopen does not insert a loading frame.
    await page.click(side ? trigger : '[data-mode="source"]'); await frames(page, 8);
    await page.evaluate(() => { (window as any).__loadingShows = []; });
    await page.click(trigger); await ready(); await delay(250);
    assert.deepEqual(await page.evaluate(() => (window as any).__loadingShows), [], 'A warm reopen must stay silent');
    await page.click(side ? trigger : '[data-mode="source"]'); await frames(page, 8);

    // Force a new source revision while hidden, then cancel a real pending load.
    await host.replaceHostText(host.readHost() + '\n\n新版本'); await gate(); await page.click(trigger);
    await page.waitForFunction(() => (window as any).__loadingEntered);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    await page.click(side ? trigger : '[data-mode="source"]'); await release(); await delay(350); await frames(page);
    assert.equal(await shown(), false, 'A cancelled response must not bring back loading');
    assert.equal(await page.$eval('#app', e => (e as HTMLElement).dataset.mode), 'source');

    await host.replaceHostText(host.readHost() + '\n\n错误恢复'); await gate(true); await page.click(trigger);
    await page.waitForFunction(() => (window as any).__loadingEntered);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    await release();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-status')!.hidden);
    assert.equal(await shown(), false, 'Failure must replace loading with an error');
    assert.deepEqual(host.errors, []);
    console.log(`Preview loading presentation passed (${side ? 'side' : 'full'})`);
  } catch (error) {
    console.error(await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('.preview-host')!, f = p.querySelector<HTMLIFrameElement>('iframe')!;
      return { mode: document.querySelector<HTMLElement>('#app')?.dataset.mode, hostHidden: p.hidden, hostInert: p.inert,
        loadingHidden: p.querySelector<HTMLElement>('.preview-loading')?.hidden, frameInert: f.inert,
        frameText: f.contentDocument?.body?.textContent?.slice(0, 140), frameUrl: f.contentDocument?.URL,
        status: p.querySelector<HTMLElement>('.preview-status')?.textContent, pending: (window as any).__loadingHold };
    }));
    console.error('Host errors:', host.errors);
    await page.screenshot({ path: '.local/preview-loading/failure.png' });
    throw error;
  } finally { await release().catch(() => {}); host.dispose(); await page.close(); }
}

async function initialPreview() {
  const page = await browser.newPage();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const opening = open(page, '# 首次以预览打开\n\n可直接阅读的正文。', false, 'preview', {
    uiLanguage: 'zh-CN', beforePreviewRender: async () => { entered(); await held; }
  });
  try {
    await started;
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    assert.equal(await page.$eval('.editor-host', e => e.hasAttribute('data-preview-cover')), false);
    release(); const host = await opening;
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    assert.deepEqual(host.errors, []); host.dispose();
    console.log('Preview loading presentation passed (initial Preview)');
  } finally { release(); await opening.catch(() => {}); await page.close(); }
}

async function delayedFramePaint() {
  const page = await browser.newPage();
  // The Host response completes before iframe commit. Feedback must last until
  // the actual paint-ready signal, rather than ending on transport completion.
  const host = await open(page, text);
  try {
    // Replace only the srcdoc commit, leaving production readiness work intact.
    await page.evaluate(() => {
      const scope = window as any, frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
      Object.defineProperty(frame, 'srcdoc', { configurable: true,
        get() { return descriptor.get!.call(frame); },
        set(value) { scope.__loadingCommitFrame = () => { delete (frame as any).srcdoc; descriptor.set!.call(frame, value); }; }
      });
    });
    // A small document uses the srcdoc writer; replacing it while hidden avoids
    // the large document's sliced writer and does not preload the new revision.
    await host.replaceHostText('# 延迟首帧\n\n正文等待首次绘制。');
    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => !!(window as any).__loadingCommitFrame);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    assert.equal(await page.$eval('.preview-host', e => e.getAttribute('aria-busy')), 'true');
    await page.evaluate(() => (window as any).__loadingCommitFrame());
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')!.hidden);
    assert.deepEqual(host.errors, []);
    console.log('Preview loading presentation passed (Host complete, frame still pending)');
  } finally { host.dispose(); await page.close(); }
}

let primaryError: unknown;
try { await exercise(false); await exercise(true); await initialPreview(); await delayedFramePaint(); }
catch (error) { primaryError = error; }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
