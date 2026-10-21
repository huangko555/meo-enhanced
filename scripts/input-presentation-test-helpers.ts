import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';

// Keep production code splitting and Workers: an IIFE mounts the editor before
// the background Preview captures its typography and cannot expose this race.
const dist = process.env.MEO_INPUT_TEST_DIST ? path.resolve(process.env.MEO_INPUT_TEST_DIST) : path.resolve(import.meta.dir, '../webview/dist');
assert.ok(fs.existsSync(path.join(dist, 'index.js')), 'Build the production Webview first');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pathname === '/') return new Response(`<!doctype html><link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css">
    <style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark"
    data-meo-katex-src="/katex/katex-embedded.css" data-meo-mermaid-module-src="/mermaid/mermaidRuntime.js"
    data-meo-shiki-worker-src="/shiki-highlight-worker.js" data-meo-markdown-worker-src="/markdown-parse-worker.js"
    data-meo-git-diff-worker-src="/git-diff-worker.js"><div id="app"></div><script type="module" src="/index.js"></script>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const file = path.resolve(dist, '.' + pathname);
  return file.startsWith(dist + path.sep) && fs.existsSync(file) ? new Response(Bun.file(file), {
    headers: pathname.endsWith('.js') ? { 'Content-Type': 'text/javascript' } : {}
  }) : new Response('Missing', { status: 404 });
} });
const browser = await launchTestBrowser().catch(error => { server.stop(true); throw error; });
const frames = async (page: Page, count = 4) => page.evaluate(async count => {
  for (let index = 0; index < count; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}, count);
async function captureResult(page: Page, label: string) {
  if (!process.argv.includes('--capture')) return;
  const directory = path.resolve('.local/input-presentation'); fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, label.replace(/[^a-z0-9-]/gi, '-') + '.png') });
}

type PaintClip = { left: number; top: number; width: number; height: number };
export let observedPaints = 0;
async function assertStablePaint(page: Page, clip: PaintClip | readonly PaintClip[], action: () => Promise<void>, label: string) {
  await page.mouse.move(2, 2);
  await frames(page);
  const viewport = page.viewport()!;
  await page.evaluate(() => {
    const witness = document.createElement('div'); witness.id = 'presentation-paint-witness';
    witness.style.cssText = 'position:fixed;left:4px;top:4px;width:8px;height:8px;background:rgb(211,47,193);z-index:2147483647;pointer-events:none';
    document.body.append(witness);
  });
  const pixels = async (png: Buffer) => {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Screencast and screenshots can use different pixel scales on HiDPI.
    // Compare consecutive compositor frames at their actual encoded resolution.
    const scale = info.width / viewport.width;
    const clips: readonly PaintClip[] = Array.isArray(clip) ? clip : [clip as PaintClip];
    const pieces = clips.map(clip => {
      const left = Math.round(clip.left * scale), top = Math.round(clip.top * scale);
      const width = Math.floor(clip.width * scale), height = Math.floor(clip.height * scale);
      assert.ok(left >= 0 && top >= 0 && left + width <= info.width && top + height <= info.height);
      const cropped = Buffer.alloc(width * height * 3);
      for (let row = 0; row < height; row++) {
        const start = ((top + row) * info.width + left) * 3;
        data.copy(cropped, row * width * 3, start, start + width * 3);
      }
      return cropped;
    });
    const marker = (Math.round(8 * scale) * info.width + Math.round(8 * scale)) * 3;
    return { cropped: Buffer.concat(pieces), witnessed: data[marker] === 211 && data[marker + 1] === 47 && data[marker + 2] === 193 };
  };
  let baseline!: Buffer, baselinePng!: Buffer;
  const difference = (value: Buffer) => {
    let count = 0;
    for (let i = 0; i < value.length; i += 3) {
      if (Math.abs(value[i]! - baseline[i]!) + Math.abs(value[i + 1]! - baseline[i + 1]!)
        + Math.abs(value[i + 2]! - baseline[i + 2]!) > 30) count++;
    }
    return count;
  };
  const client = await page.createCDPSession();
  let armed = false, delivered = 0, changed = 0;
  let firstFailure: Buffer | undefined, decodeError: unknown, resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let decoding = Promise.resolve();
  client.on('Page.screencastFrame', event => {
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    decoding = decoding.then(async () => {
      const png = Buffer.from(event.data, 'base64'), value = await pixels(png);
      // Chromium can initially deliver its previous cached paint. Arm against
      // a new paint witness before input; then inspect every delivered paint.
      if (!armed) {
        if (value.witnessed) { baseline = value.cropped; baselinePng = png; armed = true; resolveReady(); }
        return;
      }
      const count = difference(value.cropped);
      delivered++; changed = Math.max(changed, count);
      if (count > 4 && !firstFailure) firstFailure = png;
    }).catch(error => { decodeError = error; rejectReady(error); });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await Promise.race([ready, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label}: no settled compositor baseline`)), 5000);
    })]);
    clearTimeout(timeout);
    await action();
    // Quiet-time publication can happen well after the first input frame.
    await new Promise(resolve => setTimeout(resolve, 350));
    await frames(page, 8);
    await client.send('Page.stopScreencast');
    await decoding;
    if (decodeError) throw decodeError;
    observedPaints += delivered;
    assert.ok(delivered >= 2, `${label}: insufficient compositor frames (${delivered})`);
    if (firstFailure) {
      const directory = path.resolve('.local/input-presentation-failures'); fs.mkdirSync(directory, { recursive: true });
      await Bun.write(path.join(directory, label.replace(/[^a-z0-9-]/gi, '-') + '.png'), firstFailure);
      await Bun.write(path.join(directory, label.replace(/[^a-z0-9-]/gi, '-') + '-baseline.png'), baselinePng);
      await Bun.write(path.join(directory, label.replace(/[^a-z0-9-]/gi, '-') + '-frames.json'), JSON.stringify(await page.evaluate(() => {
        const scope = window as any; return scope.__presentationFrames ?? scope.__richPresentationFrames ?? [];
      })));
    }
    assert.ok(changed <= 4, `${label}: unchanged content flashed or moved in a painted frame (${changed} pixels)`);
  } finally { clearTimeout(timeout); await decoding; await client.detach();
    await page.evaluate(() => document.getElementById('presentation-paint-witness')?.remove()); }
}

async function open(page: Page, text: string, coldPreview = false) {
  let hostText = text, version = 1, ready = false, firstRender = false;
  let renderedText = '', renderedDocumentId: string | undefined;
  const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
  const renders: Array<{ fontSize: number }> = [];
  const held: Array<() => Promise<void>> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultTimeout(10_000);
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (coldPreview && ready && !firstRender && request.resourceType() === 'script' && /\/index-[^/]+\.js$/.test(request.url())) {
      held.push(() => request.continue());
    } else void request.continue();
  });
  await page.exposeFunction('__presentationHost', async (message: any) => {
    if (message.type === 'ready') {
      ready = true;
      return { type: 'init', documentId: 'file:///presentation.md', text, version, savedRevision: { version, text },
        diagnostics: [], mode: 'source', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark',
        previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        restoreReadingPositionOnOpen: false, vscodeTheme: null };
    }
    if (message.type === 'applyChanges') {
      if (message.baseVersion !== version) return { type: 'docChanged', text: hostText, version };
      for (const change of [...message.changes].sort((a, b) => b.from - a.from)) {
        hostText = hostText.slice(0, change.from) + change.insert + hostText.slice(change.to);
      }
      return { type: 'applied', version: ++version };
    }
    if (message.type === 'requestPreviewRender') {
      renders.push({ fontSize: message.environment.editorFontSizePx }); firstRender = true;
      await Promise.all(held.splice(0).map(release => release()));
      const options = { markdownText: message.text, sourceDocumentPath: '/fixture/presentation.md', uiLanguage: 'en' as const,
        preset: message.preset, styleEnvironment: message.environment };
      let value;
      if (message.window) {
        const parsed = createPreviewDocument(message.requestId, options); documents.set(message.requestId, parsed);
        value = parsed.open(message.window.anchorLine);
      } else value = exportRuntime.renderPreviewDocument(options);
      renderedText = message.text; renderedDocumentId = value.document?.id;
      return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } };
    }
    if (message.type === 'requestPreviewDocument') {
      // Force an observable inter-frame handoff. The old reading DOM must stay
      // painted while the replacement document's extra chunks are in flight.
      if (coldPreview && renders.length > 1 && message.documentId === renderedDocumentId && message.operation.kind === 'blocks') {
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      return { type: 'previewDocumentResult', requestId: message.requestId,
        documentId: message.documentId, result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
    }
    return null;
  });
  await page.evaluateOnNewDocument(() => {
    const scope = window as any;
    scope.acquireVsCodeApi = () => ({ getState() { return scope.__presentationState; }, setState(value: unknown) { scope.__presentationState = value; },
      postMessage(message: unknown) { scope.__presentationHost(message).then((data: unknown) => { if (data) window.dispatchEvent(new MessageEvent('message', { data })); }); } });
  });
  await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor') && !document.querySelector('.meo-preload-toolbar')
    && !document.querySelector('.editor-host')?.hasAttribute('inert') && !document.querySelector('.mode-group [aria-busy="true"]'));
  return { renders, errors, readHost: () => hostText, readPresentation: () => ({ text: renderedText, id: renderedDocumentId }),
    dispose() { for (const doc of documents.values()) doc.dispose(); } };
}


export { browser, server, open, frames, assertStablePaint, captureResult };
