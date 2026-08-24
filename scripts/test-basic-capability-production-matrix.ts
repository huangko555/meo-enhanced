import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-basic-capability-index-'));
const target = 'format target';
const actions = [['bold', `**${target}**`], ['italic', `*${target}*`], ['lineover', `~~${target}~~`], ['highlight', `==${target}==`], ['inlineCode', `\`${target}\``], ['link', `[${target}]()`], ['wikiLink', `[[${target}]]`], ['kbd', `<kbd>${target}</kbd>`], ['underline', `<u>${target}</u>`]] as const;

const init = (text: string, mode: 'live' | 'source') => ({ type: 'init', documentId: `file:///basic-${mode}.md`, text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode, previewAppearance: 'light', previewSourceColoring: true, editorAppearance: 'light', gitChangesGutter: false, gitDiffLineHighlights: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null });

async function open(browser: Browser, text: string, mode: 'live' | 'source'): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
  await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
  await page.addScriptTag({ content: `
    window.__hostMessages=[];
    window.acquireVsCodeApi=()=>({
      postMessage(m) {
        window.__hostMessages.push(m);
        if(m.type !== 'requestPreviewRender') return;
        const html='<p>'+String(m.text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</p>';
        queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{
          type:'previewRenderResult',requestId:m.requestId,
          result:{ok:true,value:{html,hasMermaid:false,styles:{light:'',dark:''}}}
        }})));
      },
      getState(){return undefined},setState(){}
    });
  ` });
  await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), init(text, mode));
  await page.waitForSelector('.editor-host > .cm-editor');
  return page;
}

async function select(page: Page, text = target): Promise<void> {
  const points = await page.evaluate((needle) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find((x) => x.textContent?.includes(needle));
    const walker = line ? document.createTreeWalker(line, NodeFilter.SHOW_TEXT) : null;
    let candidate: Node | null = walker?.nextNode() ?? null, node: Text | null = null;
    while (candidate) { if (candidate instanceof Text && candidate.textContent?.includes(needle)) { node = candidate; break; } candidate = walker?.nextNode() ?? null; }
    const value = node?.textContent ?? '', start = value.indexOf(needle);
    if (!node || start < 0) return null;
    const a = document.createRange(), b = document.createRange(); a.setStart(node, start); a.setEnd(node, start + 1); b.setStart(node, start + needle.length - 1); b.setEnd(node, start + needle.length);
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect(); return { a: [ar.left + 1, ar.top + ar.height / 2], b: [br.right - 1, br.top + br.height / 2] };
  }, text);
  assert.ok(points, `missing ${text}`); await page.mouse.move(...points.a); await page.mouse.down(); await page.mouse.move(...points.b, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') === true);
}

const drafts = (page: Page) => page.evaluate(() => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').map((m: any) => m.text));

async function matrix(browser: Browser): Promise<void> {
  for (const mode of ['source', 'live'] as const) for (const [action, expected] of actions) {
    const page = await open(browser, target, mode); try {
      await select(page); await page.click(`.selection-inline-button[data-action="${action}"]`);
      await page.waitForFunction((x) => (window as any).__hostMessages.some((m: any) => m.type === 'draftChanged' && m.text === x), {}, expected); assert.deepEqual(await drafts(page), [expected]);
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await page.waitForFunction((x) => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').at(-1)?.text === x, {}, target);
      await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); await page.waitForFunction((x) => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').at(-1)?.text === x, {}, expected); assert.deepEqual(await drafts(page), [expected, target, expected]);
    } finally { await page.close(); }
  }
}

async function preview(browser: Browser): Promise<void> {
  const page = await open(browser, target, 'source'); try {
    await select(page); // Source baseline: the permanent page controller exposes its real menu.
    await page.click('[data-mode="live"]'); await page.waitForSelector('.editor-host .cm-editor.meo-mode-live'); const old = await page.$('.selection-inline-button[data-action="underline"]'); const oldRect = await old?.boundingBox(); const before = await drafts(page);
    await page.click('[data-mode="preview"]'); await page.waitForSelector('.preview-host:not([hidden]) .preview-frame'); await page.waitForFunction((needle) => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes(needle) === true, {}, target);
    const state = await page.evaluate(() => { const menu = document.querySelector<HTMLElement>('.selection-inline-menu')!, doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, range = doc.createRange(); range.selectNodeContents(doc.body); const selection = doc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return { visible: menu.classList.contains('is-visible'), pointer: getComputedStyle(menu).pointerEvents, frameMenu: Boolean(doc.querySelector('.selection-inline-menu')), frameFormat: Boolean(doc.querySelector('[data-action],button')), copy: selection?.toString() ?? '', copied: doc.execCommand('copy') }; });
    assert.deepEqual({ ...state, copy: state.copy.includes(target) }, { visible: false, pointer: 'none', frameMenu: false, frameFormat: false, copy: true, copied: true });
    if (oldRect) await page.mouse.click(oldRect.x + oldRect.width / 2, oldRect.y + oldRect.height / 2); assert.deepEqual(await drafts(page), before);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload'))); assert.deepEqual(await drafts(page), before);
  } finally { await page.close(); }
}

async function alerts(browser: Browser): Promise<void> {
  const page = await open(browser, '> [!NOTE]\n> note body\n\n> [!UNKNOWN]\n> unknown body', 'live'); try {
    const point = await page.evaluate(() => { const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find((x) => x.textContent === '> unknown body'); const rect = line?.getBoundingClientRect(); return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null; }); assert.ok(point, 'unknown alert body did not render'); await page.mouse.click(point.x, point.y); await page.waitForFunction(() => document.querySelectorAll('.meo-md-alert-icon').length === 1);
    const state = await page.evaluate(() => { const lines = [...document.querySelectorAll<HTMLElement>('.cm-line')]; const read = (text: string) => { const x = lines.find((line) => line.textContent === text)!; return { quote: x.classList.contains('meo-md-quote'), alert: x.classList.contains('meo-md-alert'), icon: Boolean(x.querySelector('.meo-md-alert-icon,.meo-md-alert-label')) }; }; return { directive: read('> [!UNKNOWN]'), body: read('> unknown body'), known: Boolean(document.querySelector('.meo-md-alert-note .meo-md-alert-icon')) }; });
    assert.deepEqual(state, { directive: { quote: true, alert: false, icon: false }, body: { quote: true, alert: false, icon: false }, known: true });
  } finally { await page.close(); }
}

async function main() { const build = await Bun.build({ entrypoints: [path.join(root, 'scripts', 'test-basic-capability-index-entry.ts')], outdir: temp, target: 'browser', format: 'iife', naming: 'bundle.js' }); if (!build.success) throw new Error(build.logs.map(String).join('\n')); const browser = await launchTestBrowser(); try { await matrix(browser); await preview(browser); await alerts(browser); } finally { await browser.close(); } console.log('Basic capability production matrix passed'); }
main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
