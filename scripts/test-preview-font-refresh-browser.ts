import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { createPreviewFonts } from '../src/host/previewFonts';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const family = 'KaTeX_Typewriter';
const codeFamily = 'KaTeX_Main';
const directory = mkdtempSync(join(tmpdir(), 'meo-font-refresh-fixture-'));
// Put the code face second: loading a TTC's first face would silently draw the wrong font.
const fontBuffers = ['Typewriter', 'Main'].map(name => readFileSync(`node_modules/katex/dist/fonts/KaTeX_${name}-Regular.ttf`));
const collection = Buffer.alloc(20 + fontBuffers.reduce((size, font) => size + ((font.length + 3) & ~3), 0));
collection.write('ttcf'); collection.writeUInt32BE(0x00010000, 4); collection.writeUInt32BE(2, 8);
let offset = 20;
for (const [index, font] of fontBuffers.entries()) {
  collection.writeUInt32BE(offset, 12 + index * 4); font.copy(collection, offset);
  for (let table = 0; table < font.readUInt16BE(4); table++) {
    const record = offset + 12 + table * 16 + 8;
    collection.writeUInt32BE(collection.readUInt32BE(record) + offset, record);
  }
  offset += (font.length + 3) & ~3;
}
const collectionPath = join(directory, 'fixture.ttc'); writeFileSync(collectionPath, collection);
const resources = new Map<string, Uint8Array>();
const server = Bun.serve({ port: 0, async fetch(request) {
  const bytes = resources.get(new URL(request.url).pathname);
  if (!bytes) return new Response(null, { status: 404 });
  await new Promise(resolve => setTimeout(resolve, 700));
  return new Response(bytes, { headers: { 'Content-Type': 'font/ttf', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
} });
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  browser = await launchTestBrowser();
  for (const large of [false, true]) for (const split of [false, true]) {
    const page = await browser.newPage();
    const text = '# Font refresh\n\nWimwm III 123 `Wimwm III 123`\n\n' + Array.from({ length: large ? 200 : 12 }, (_, index) =>
      `Reading paragraph ${index + 1}. ` + 'A long font fixture paragraph. '.repeat(large ? 80 : 20)).join('\n\n');
    assert.equal(assessLargeDocument(text).windowedPreview, large);
    let installed = false;
    let enumerations = 0;
    const catalog = createPreviewFonts(async () => {
      enumerations++;
      return [{ family: 'Arial', aliases: [] }, ...(installed ? [{ family, aliases: [] }, { family: codeFamily, aliases: [] }] : [])];
    }, async name => name === family || name === codeFamily ? [{
      path: name === family ? resolve('node_modules/katex/dist/fonts/KaTeX_Typewriter-Regular.ttf') : collectionPath,
      weight: 400, style: 'normal', stretch: 5
    }] : []);
    try {
      const requests: any[] = [];
      const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
      await page.setViewport({ width: 1200, height: 800 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.exposeFunction('__fontRefreshHost', async (message: any) => {
        requests.push(message);
        if (message.type === 'getPreviewFonts') {
          return { type: 'previewFontsResult', requestId: message.requestId, result: { ok: true, value: await catalog.read(message.refresh) } };
        }
        if (message.type === 'requestPreviewDocument') return { type: 'previewDocumentResult', requestId: message.requestId,
          documentId: message.documentId, result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
        if (message.type !== 'requestPreviewRender') return null;
        const options = { markdownText: message.text, sourceDocumentPath: 'C:/notes/font-refresh.md', uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth };
        const value = message.window ? (() => {
          const document = createPreviewDocument(message.requestId, options); documents.set(message.requestId, document);
          return document.open(message.window.anchorLine);
        })() : exportRuntime.renderPreviewDocument(options);
        const embeddedStyles = await catalog.styles([message.environment.previewFontFamily, message.environment.previewCodeFontFamily ?? '']);
        // Keep the deliberately late font-completion contrast. The installed
        // acceptance separately exercises the production data URLs inside VS Code.
        const styles = embeddedStyles.replace(/url\("(data:font\/[^;]+;base64,[^"]+)"\)/g, (_, source: string) => {
          const uri = new URL(source), key = `/font-${resources.size}.ttf`;
          resources.set(key, Buffer.from(uri.pathname.split(',')[1], 'base64'));
          return `url("http://localhost:${server.port}${key}${uri.hash}")`;
        });
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
          value: { ...value, styles: { light: value.styles.light + styles, dark: value.styles.dark + styles } } } };
      });
      await page.addScriptTag({ content: `window.__fontPending=0;window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){
        window.__fontPending++;window.__fontRefreshHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));}).finally(()=>window.__fontPending--);
      }});` });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), {
        type: 'init', documentId: 'file:///font-refresh.md', text, version: 1, savedRevision: { version: 1, text },
        diagnostics: [], mode: 'preview', uiLanguage: 'en', sourceLineNumbers: 'on', editorAppearance: 'light', previewFontFamily: '',
        previewCodeFontFamily: '', previewAppearance: 'auto', previewSourceColoring: true, previewShowComments: false,
        previewPreset: 'whitey', gitChangesGutter: false, gitDiffLineHighlights: false,
        gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
        outlineVisible: false, outlineWidth: 260, vscodeTheme: null
      });
      const settle = () => page.waitForFunction(() => (window as any).__fontPending === 0);
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('p code'));
      await settle();
      await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.preview-host');
        return host && !host.hidden && !host.inert && !host.querySelector<HTMLElement>('.preview-loading:not([hidden])');
      });
      await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar'));
      if (split) {
        await page.click('button[data-mode="source"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source');
        if (await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') !== 'true')) await page.click('.source-preview-button');
        await page.waitForFunction(() => document.querySelector('.source-preview-more-panel .preview-preset-control')
          && !document.querySelector<HTMLElement>('.preview-host')!.inert);
        await settle();
      }
      assert.equal(requests.some(request => request.type === 'requestPreviewRender' && Boolean(request.window)), large);
      const frameBounds = await page.$eval('.preview-frame', element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
      await page.mouse.move(frameBounds.x, frameBounds.y); await page.mouse.wheel({ deltaY: 300 });
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop > 200)
        .catch(error => { throw new Error(`The ${large ? 'windowed' : 'ordinary'} Preview must accept wheel input before font comparison`, { cause: error }); });
      await page.evaluate(() => new Promise<void>(resolve => { let frames = 20; const next = () => --frames ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next); }));
      const client = await page.createCDPSession();
      await client.send('DOM.enable'); await client.send('CSS.enable');
      const renderedFonts = async (selector: string) => {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const frame = root.children?.find(node => node.nodeName === 'HTML')?.children?.find(node => node.nodeName === 'BODY');
        const findDocument = (node: any): any => node.nodeName === 'IFRAME' ? node.contentDocument : node.children?.map(findDocument).find(Boolean);
        const document = findDocument(frame);
        const { nodeId } = await client.send('DOM.querySelector', { nodeId: document.nodeId, selector });
        return (await client.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
      };
      assert.ok(!(await renderedFonts('p')).some(font => font.familyName === family), 'Cold renderer must not already have the fixture font');
      await page.click(split ? '.source-preview-more-button' : '.preview-options-trigger'); await page.click('.preview-font-family-dropdown'); await settle();
      assert.equal(enumerations, 1);
      await page.evaluate(() => { (window as any).__fontRoot = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('main'); });
      installed = true;
      await page.click('.preview-font-family-dropdown-panel .preview-font-refresh'); await settle();
      assert.equal(enumerations, 2);
      await page.type('.preview-font-family-dropdown-panel input', family);
      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const root = doc.querySelector('main')!.getBoundingClientRect();
        const range = doc.caretRangeFromPoint(Math.max(4, root.left + 12), doc.defaultView!.innerHeight / 3)!;
        if (range.startContainer.nodeType !== 3 || !range.getBoundingClientRect().height) throw new Error('A painted reading witness is required');
        (window as any).__fontWitness = { range, top: range.getBoundingClientRect().top };
      });
      await page.click(`.preview-font-family-dropdown-panel [data-value="${family}"]`); await settle();
      await page.evaluate(async () => { await document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.fonts.ready; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const readingDelta = await page.evaluate(() => { const witness = (window as any).__fontWitness; return Math.abs(witness.range.getBoundingClientRect().top - witness.top); });
      assert.ok(readingDelta <= 2, `Late font completion retains the painted reading character (${large ? 'windowed' : 'ordinary'}): ${readingDelta}px`);
      const actual = await renderedFonts('p');
      assert.ok(actual.some(font => font.familyName === family), `Refreshed font must draw real glyphs without restarting (${large ? 'windowed' : 'ordinary'}): ${JSON.stringify(actual)}`);
      await page.keyboard.press('Escape'); await page.click('.preview-code-font-family-dropdown');
      await page.type('.preview-code-font-family-dropdown-panel input', codeFamily);
      await page.click(`.preview-code-font-family-dropdown-panel [data-value="${codeFamily}"]`); await settle();
      await page.evaluate(async () => { await document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.fonts.ready; });
      assert.ok((await renderedFonts('p code')).some(font => font.familyName === codeFamily && font.isCustomFont),
        'Code font uses the matching collection face, independently of body typography');
      const beforeRefresh = requests.filter(request => request.type === 'requestPreviewRender').length;
      await page.click('.preview-code-font-family-dropdown-panel .preview-font-refresh'); await settle();
      await page.evaluate(async () => { await document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.fonts.ready; });
      assert.equal(requests.filter(request => request.type === 'requestPreviewRender').length, beforeRefresh + 1,
        'Refreshing reapplies already selected fonts even when their family names have not changed');
      assert.equal(await page.evaluate(() => (window as any).__fontRoot === document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('main')), true,
        'Font refresh retains the accepted reading DOM');
      assert.ok((await renderedFonts('p')).some(font => font.familyName === family));
      assert.ok((await renderedFonts('p code')).some(font => font.familyName === codeFamily));
      assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.documentElement.dataset.meoPreviewWindowed), String(large));
      if (large) assert.ok(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelectorAll('p').length < 40), 'Large font refresh keeps a bounded reading window');
      await page.screenshot({ path: `tmp/preview-font-refresh-${split ? 'split-' : ''}${large ? 'windowed' : 'ordinary'}.png` });
    } finally { await page.close(); await catalog.dispose(); }
  }
} finally { await browser?.close(); server.stop(true); rmSync(directory, { recursive: true, force: true }); }
console.log('Newly installed fonts draw real glyphs in full/split Preview, ordinary/windowed documents, without restarting.');
