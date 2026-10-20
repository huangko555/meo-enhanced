import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { createLargeDocumentFixtures } from './large-document-fixtures';

// Keep production code splitting and Workers: an IIFE mounts the editor before
// the background Preview captures its typography and cannot expose this race.
const dist = path.resolve(import.meta.dir, '../webview/dist');
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
let primaryError: unknown;
let stage = 'startup';
const richOnly = process.argv.includes('--rich-only'), stickyOnly = process.argv.includes('--sticky-only'), heightOnly = process.argv.includes('--height-only');
const frames = async (page: Page, count = 4) => page.evaluate(async count => {
  for (let index = 0; index < count; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}, count);
async function captureResult(page: Page, label: string) {
  if (!process.argv.includes('--capture')) return;
  const directory = path.resolve('.local/input-presentation'); fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, label.replace(/[^a-z0-9-]/gi, '-') + '.png') });
}

type PaintClip = { left: number; top: number; width: number; height: number };
let observedPaints = 0;
async function assertStablePaint(page: Page, clip: PaintClip, action: () => Promise<void>, label: string) {
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
    const left = Math.round(clip.left * scale), top = Math.round(clip.top * scale);
    const width = Math.floor(clip.width * scale), height = Math.floor(clip.height * scale);
    assert.ok(left >= 0 && top >= 0 && left + width <= info.width && top + height <= info.height);
    const cropped = Buffer.alloc(width * height * 3);
    for (let row = 0; row < height; row++) {
      const start = ((top + row) * info.width + left) * 3;
      data.copy(cropped, row * width * 3, start, start + width * 3);
    }
    const marker = (Math.round(8 * scale) * info.width + Math.round(8 * scale)) * 3;
    return { cropped, witnessed: data[marker] === 211 && data[marker + 1] === 47 && data[marker + 2] === 193 };
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
        const scope = window as any; return scope.__presentationFrames ?? scope.__richPresentationFrames;
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

async function exerciseInput(page: Page) {
  await page.keyboard.type('12a');
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.keyboard.press('Backspace');
  await page.keyboard.sendCharacter('中文🙂');
  await page.keyboard.press('Backspace');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', ' paste ');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
  }), true, 'exercise the production paste handler without accessing the system clipboard');
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.keyboard.down('Shift');
  for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift'); await page.keyboard.type('TE ');
  const read = () => page.$eval('.editor-host > .cm-editor .cm-content', element => (element as any).cmTile.root.view.state.doc.toString() as string);
  const beforeUndo = await read();
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.notEqual(await read(), beforeUndo, 'undo must change the accepted document');
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  assert.equal(await read(), beforeUndo, 'redo must restore the input exactly');
  await page.keyboard.press('Delete');
  assert.notEqual(await read(), beforeUndo, 'forward deletion must reach the accepted document');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal(await read(), beforeUndo, 'undo must restore forward deletion exactly');
  const beforeComposition = await page.$eval('.editor-host > .cm-editor .cm-content', element => {
    const view = (element as any).cmTile.root.view, range = view.state.selection.main;
    const native = window.getSelection()!;
    return { text: view.state.doc.toString() as string, from: range.from as number, to: range.to as number,
      anchor: range.anchor as number, head: range.head as number,
      nativeAnchor: view.posAtDOM(native.anchorNode, native.anchorOffset) as number,
      nativeHead: view.posAtDOM(native.focusNode, native.focusOffset) as number };
  });
  assert.equal(beforeComposition.nativeAnchor, beforeComposition.anchor, 'history must retain the native selection anchor');
  assert.equal(beforeComposition.nativeHead, beforeComposition.head, 'history must retain the native caret');
  const ime = await page.createCDPSession();
  try {
    await ime.send('Input.imeSetComposition', { text: '输', selectionStart: 1, selectionEnd: 1 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await ime.send('Input.imeSetComposition', { text: '输入', selectionStart: 2, selectionEnd: 2 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await ime.send('Input.insertText', { text: '输入' });
  } finally { await ime.detach(); }
  return { text: await read(), beforeComposition: beforeComposition.text,
    expected: beforeComposition.text.slice(0, beforeComposition.from) + '输入' + beforeComposition.text.slice(beforeComposition.to) };
}

async function assertRichInput(page: Page, mode: 'source' | 'live', text: string, label: string, split = false) {
  if (split) {
    await page.locator('.source-preview-button').click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden
      && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('table'));
    if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true')) {
      await page.locator('.source-preview-scroll-sync-button').click();
    }
    await page.waitForFunction(() => document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed') === 'false');
  }
  if (mode === 'live') {
    await page.locator('.mode-group [data-mode="live"]').click();
    await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor.meo-mode-live')
      && !document.querySelector('.mode-group [aria-busy="true"]'));
    await page.waitForSelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea');
  }
  await page.evaluate(() => {
    const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Typing target') + 8 } });
    view.focus(); view.scrollDOM.scrollTop = 0;
  });
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  await new Promise(resolve => setTimeout(resolve, 500));
  const baseline = await page.evaluate(() => {
    const scope = window as any;
    scope.__readRichPresentation = () => {
      const editor = document.querySelector('.editor-host > .cm-editor')!;
      return { scroll: editor.querySelector('.cm-scroller')!.scrollTop,
        width: editor.querySelector('.cm-content')!.getBoundingClientRect().width,
        widgets: [...editor.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table), .meo-md-html-table thead th, .meo-code-language-label, .meo-md-html-table-sticky-header, .meo-block-sticky-header')]
          .map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }) };
    };
    scope.__richPresentationFrames = []; scope.__sampleRichPresentation = true;
    const sample = () => { if (!scope.__sampleRichPresentation) return;
      setTimeout(() => { if (scope.__sampleRichPresentation) scope.__richPresentationFrames.push(scope.__readRichPresentation()); }, 0);
      requestAnimationFrame(sample);
    }; requestAnimationFrame(sample); return scope.__readRichPresentation();
  });
  const clip = split ? await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { left: Math.ceil(rect.left + 25), top: Math.ceil(rect.top + 120), width: Math.floor(rect.width - 50), height: Math.floor(rect.height - 150) };
  }) : mode === 'live' ? { left: 65, top: 150, width: 1130, height: 620 }
    : { left: 65, top: 190, width: 1130, height: 580 };
  let result!: Awaited<ReturnType<typeof exerciseInput>>;
  await assertStablePaint(page, clip, async () => { result = await exerciseInput(page); }, label);
  const sampled = await page.evaluate(() => { const scope = window as any; scope.__sampleRichPresentation = false; return scope.__richPresentationFrames; });
  for (const frame of sampled) {
    assert.ok(Math.abs(frame.scroll - baseline.scroll) <= 1, `${label}: input scrolled the editor`);
    assert.equal(frame.width, baseline.width, `${label}: editor width changed`);
    assert.deepEqual(frame.widgets, baseline.widgets, `${label}: unchanged table columns or code/table headers moved`);
  }
  const offset = text.indexOf('Typing target') + 8;
  assert.equal(result.beforeComposition, text.slice(0, offset) + '12中文 pasTE ' + text.slice(offset), `${label}: input, emoji deletion, paste, replacement and history must preserve exact source`);
  assert.equal(result.text, result.expected, `${label}: composition must insert at the restored native/model selection`);
  return result.text;
}

try {
  const paragraphs = 'Typing target.\n\n' + Array.from({ length: 70 }, (_, index) => `Unchanged paragraph ${index}.`).join('\n\n');
  for (const windowed of richOnly || stickyOnly || heightOnly ? [] : [false, true]) for (const sync of [false, true]) {
    const text = paragraphs + (windowed ? '\n\n' + Array.from({ length: 5000 }, (_, index) => `Far paragraph ${index}.\n\n`).join('') : '');
    stage = `Source split Preview, windowed ${windowed}, sync ${sync}`;
    const page = await browser.newPage(), host = await open(page, text, true);
    try {
      await page.locator('.source-preview-button').click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden
        && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('p'));
      if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true') !== sync) {
        await page.locator('.source-preview-scroll-sync-button').click();
      }
      await page.waitForFunction(sync => document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed') === String(sync), {}, sync);
      await page.evaluate(({ sync, windowed }) => {
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: 8 } }); view.focus();
        if (!sync) {
          const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
          scroll.scrollTop = windowed ? scroll.scrollHeight / 2 : 600;
        }
      }, { sync, windowed });
      await frames(page, 8);
      await page.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        return [...doc.querySelectorAll('p[data-source-line]')].some(element => {
          const rect = element.getBoundingClientRect(); return rect.top > 150 && rect.bottom < doc.defaultView!.innerHeight;
        });
      });
      const baseline = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const reading = [...doc.querySelectorAll<HTMLElement>('p[data-source-line]')].find(element => element.getBoundingClientRect().top > 150)!;
        (window as any).__stablePreviewText = reading.textContent;
        return { scroll: doc.scrollingElement!.scrollTop, top: reading.getBoundingClientRect().top, font: doc.defaultView!.getComputedStyle(reading).fontSize };
      });
      await page.evaluate(() => {
        const scope = window as any; scope.__presentationFrames = []; scope.__samplePresentation = true;
        const sample = () => {
          if (!scope.__samplePresentation) return;
          setTimeout(() => {
            if (!scope.__samplePresentation) return;
            const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
            const reading = [...doc.querySelectorAll<HTMLElement>('p[data-source-line]')].find(element => element.textContent === scope.__stablePreviewText);
            scope.__presentationFrames.push({ scroll: doc.scrollingElement!.scrollTop, top: reading?.getBoundingClientRect().top,
              font: reading && doc.defaultView!.getComputedStyle(reading).fontSize, height: doc.body.getBoundingClientRect().height });
          }, 0);
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
      });
      const clip = await page.$eval('.preview-frame', element => {
        const rect = element.getBoundingClientRect();
        return { left: Math.ceil(rect.left + 25), top: Math.ceil(rect.top + 160), width: Math.floor(rect.width - 50), height: Math.floor(rect.height - 190) };
      });
      await assertStablePaint(page, clip, async () => {
        for (const key of sync ? ['1', 'a', 'Backspace'] : ['1', 'a', 'Backspace', 'Enter', 'Backspace']) {
          if (key.length === 1) await page.keyboard.type(key); else await page.keyboard.press(key);
          // Allow each windowed update to commit even with the delayed chunk
          // response; the rich-input matrix separately exercises rapid bursts.
          await new Promise(resolve => setTimeout(resolve, windowed ? 320 : 170));
        }
      }, `Source-Preview-windowed-${windowed}-sync-${sync}`);
      await frames(page, 8);
      const sampled = await page.evaluate(() => { const scope = window as any; scope.__samplePresentation = false; return scope.__presentationFrames; });
      assert.ok(host.renders.length >= 2, 'the edit must reach a new production Preview render');
      assert.equal(host.renders[0].fontSize, host.renders.at(-1)!.fontSize, 'cold preload and edited Preview must capture identical document typography');
      for (const frame of sampled) {
        assert.equal(frame.font, baseline.font, `${stage}: untouched paragraph font changed`);
        assert.ok(Math.abs(frame.top - baseline.top) <= 1, `${stage}: untouched reading content moved: ${JSON.stringify({ baseline, frame })}`);
        // Estimated gaps can change their absolute height when a new window
        // accepts measurements. Its visible reading content must stay fixed.
        if (!windowed) assert.ok(Math.abs(frame.scroll - baseline.scroll) <= 1, `${stage}: input scrolled the follower: ${JSON.stringify({ baseline, frame })}`);
      }
      assert.equal(host.readHost(), text.slice(0, 8) + '1' + text.slice(8));
      assert.equal(host.readPresentation().text, host.readHost(), 'the final preview request must include the latest source');
      if (windowed) {
        await page.waitForFunction(id => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector<HTMLElement>('main.meo-export-doc')?.dataset.meoPreviewDocument === id, {}, host.readPresentation().id);
      } else {
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('p')?.textContent?.includes('t1arget'));
      }
      assert.deepEqual(host.errors, []);
      await captureResult(page, `Source-Preview-windowed-${windowed}-sync-${sync}`);
    } finally { host.dispose(); await page.close(); }
  }
  stage = 'Live asynchronous input retains offscreen table geometry';
  if (!richOnly && !stickyOnly) {
    const page = await browser.newPage();
    const text = '# Stable heading\n\nTyping target.\n\n```js\nconst stable = 1;\n```\n\n' + 'Paragraph.\n\n'.repeat(1000)
      + '| A | B |\n| --- | --- |\n| one | two |\n\n' + 'Paragraph.\n\n'.repeat(1000);
    const host = await open(page, text);
    try {
      await page.locator('.mode-group [data-mode="live"]').click();
      await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor.meo-mode-live')
        && !document.querySelector('.mode-group [aria-busy="true"]'));
      await page.evaluate(() => {
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Typing target') + 8 } }); view.focus();
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      const baseline = await page.evaluate(() => {
        const scope = window as any;
        scope.__liveHeights = []; scope.__sampleHeights = true;
        const read = () => document.querySelector('.editor-host > .cm-editor .cm-content')!.getBoundingClientRect().height;
        const sample = () => { if (!scope.__sampleHeights) return;
          setTimeout(() => { if (scope.__sampleHeights) scope.__liveHeights.push(read()); }, 0);
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample); return read();
      });
      await page.keyboard.type('1');
      await new Promise(resolve => setTimeout(resolve, 200));
      await page.keyboard.press('Backspace');
      await new Promise(resolve => setTimeout(resolve, 500));
      const heights: number[] = await page.evaluate(() => { const scope = window as any; scope.__sampleHeights = false; return scope.__liveHeights; });
      assert.ok(heights.length >= 5, 'observe both the input frame and later asynchronous settlement');
      assert.ok(heights.every(height => Math.abs(height - baseline) <= 1), `${stage}: ${JSON.stringify({ baseline, heights: [...new Set(heights)] })}`);
      assert.equal(host.readHost(), text);
      assert.deepEqual(host.errors, []);
      await captureResult(page, 'Live-offscreen-geometry');
    } finally { host.dispose(); await page.close(); }
  }
  const picture = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32"><rect width="96" height="32" fill="#4c9aff"/><circle cx="48" cy="16" r="10" fill="#e5c07b"/></svg>').toString('base64');
  const rich = ['# Input presentation', '', 'Typing target.', '',
    '| N | Description | More |', '| --- | --- | --- |',
    '| 1 | A longer description with **formatting** | x |', '| 2 | Unchanged content | y |', '',
    '```typescript', 'const stable = 123;', 'const other = stable + 2;', '```', '',
    '> Unchanged quote with *emphasis*.', '', '- [ ] Stable task', '',
    'Footnote reference[^n].', '', '[^n]: Stable footnote.', '',
    '$$', 'x^2 + y^2 = 1', '$$', '',
    `![Stable picture](${picture})`, '',
    '<details open><summary>Stable details</summary>Unchanged HTML content.</details>', '',
    ...Array.from({ length: 35 }, (_, index) => `Unchanged tail ${index}.`)].join('\n');
  const fixtures = createLargeDocumentFixtures();
  const large = rich + '\n\n' + Array(3).fill(fixtures.find(fixture => fixture.kind === 'composite')!.text).join('\n\n')
    + '\n\n' + fixtures.find(fixture => fixture.kind === 'rich-heavy')!.text;
  assert.ok(Buffer.byteLength(large) >= 1_000_000, 'the rich input matrix must also exercise a megabyte document');
  const inputScenes = [['source', rich, 'Source-rich', 1, false], ['live', rich, 'Live-rich', 1, false], ['live', large, 'Live-megabyte-rich', 1, false], ['live', rich, 'Live-rich-hidpi', 1.25, false],
    ['source', rich, 'Source-Preview-rich', 1, true], ['source', large, 'Source-Preview-megabyte-rich', 1, true]] as const;
  for (const [mode, document, label, scale, split] of stickyOnly || heightOnly ? [] : inputScenes) {
    stage = label;
    const page = await browser.newPage(), host = await open(page, document);
    try {
      if (scale !== 1) await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: scale });
      const finalText = await assertRichInput(page, mode, document, label, split);
      assert.equal(host.readHost(), finalText, `${label}: host acknowledgements must preserve every edit`);
      assert.deepEqual(host.errors, []);
      await captureResult(page, label);
    } finally { host.dispose(); await page.close(); }
  }
  for (const kind of heightOnly || richOnly ? [] : ['table', 'code', 'code-large']) {
    stage = `Live floating ${kind} header`;
    const document = (kind === 'table'
      ? ['| Row | Description | N |', '| --- | --- | --- |', ...Array.from({ length: 60 }, (_, i) => `| row-${i} | Unchanged description | 1 |`), '', ...Array(60).fill('Tail.')].join('\n')
      : ['```typescript', ...Array.from({ length: 70 }, (_, i) => `const item${i} = ${i};`), '```', '', ...Array(60).fill('Tail.')].join('\n'))
      + (kind === 'code-large' ? '\n\n' + large : '');
    const page = await browser.newPage(), host = await open(page, document);
    try {
      await page.locator('.mode-group [data-mode="live"]').click();
      await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor.meo-mode-live')
        && !document.querySelector('.mode-group [aria-busy="true"]'));
      if (kind === 'table') await page.waitForSelector('tbody textarea[data-table-row="18"][data-table-col="2"]');
      await page.evaluate(kind => {
        const scope = window as any;
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        if (kind === 'table') {
          const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="18"][data-table-col="2"]')!;
          input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
          view.scrollDOM.scrollTop += input.getBoundingClientRect().top - 400;
          scope.__readActiveTop = () => input.getBoundingClientRect().top;
        } else {
          const position = view.state.doc.toString().indexOf('const item20') + 6;
          view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
          view.scrollDOM.scrollTop += view.coordsAtPos(position).top - 400;
          scope.__readActiveTop = () => view.contentDOM.querySelector('.cm-activeLine')?.getBoundingClientRect().top;
        }
      }, kind);
      const selector = kind === 'table' ? '.meo-md-html-table-sticky-chrome.is-visible .meo-md-html-table-sticky-header' : '.meo-block-sticky-header:not([hidden])';
      await page.waitForSelector(selector, { visible: true });
      await frames(page, 12);
      const header = await page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        return { left: Math.ceil(rect.left + 3), top: Math.ceil(rect.top + 2), width: Math.floor(rect.width - 6), height: Math.floor(rect.height - 4) };
      });
      assert.ok(header.width > 50 && header.height > 8, 'a real floating header must be visible');
      const baseline = await page.evaluate(selector => {
        const scope = window as any;
        scope.__stickyFrames = []; scope.__sampleSticky = true;
        scope.__readSticky = () => { const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, activeTop: scope.__readActiveTop() }; };
        const sample = () => { if (!scope.__sampleSticky) return;
          setTimeout(() => { if (scope.__sampleSticky) scope.__stickyFrames.push(scope.__readSticky()); }, 0); requestAnimationFrame(sample); };
        requestAnimationFrame(sample); return scope.__readSticky();
      }, selector);
      assert.equal(typeof baseline.activeTop, 'number', 'the active input must be a measurable reading witness');
      await assertStablePaint(page, header, async () => {
        if (kind !== 'table') {
          const guarded = await page.evaluate(() => {
            const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
            const header = document.querySelector<HTMLElement>('.meo-block-sticky-header')!;
            const button = header.querySelector<HTMLElement>('.meo-copy-code-btn')!;
            const previousTo = Number(header.dataset.meoBlockTo);
            let reached = 0;
            const probe = (event: Event) => { reached++; event.preventDefault(); event.stopImmediatePropagation(); };
            button.addEventListener('click', probe, true);
            const position = view.state.selection.main.head;
            view.dispatch({ changes: { from: position, insert: '0' }, selection: { anchor: position + 1 }, userEvent: 'input.type' });
            if (Number(header.dataset.meoBlockTo) === previousTo + 1 && !header.hidden) {
              button.removeEventListener('click', probe, true);
              return { reached: 0, blocked: true, painted: !!header.querySelector('.meo-copy-code-btn') };
            }
            const click = new MouseEvent('click', { bubbles: true, cancelable: true }); button.dispatchEvent(click);
            button.removeEventListener('click', probe, true);
            return { reached, blocked: click.defaultPrevented, painted: !header.hidden && button.isConnected };
          });
          assert.deepEqual(guarded, { reached: 0, blocked: true, painted: true }, 'floating controls must be current or reject stale callbacks while retaining paint');
        }
        await page.keyboard.type('12'); await new Promise(resolve => setTimeout(resolve, 180));
        await page.keyboard.press('Backspace'); await page.keyboard.sendCharacter('中');
      }, `Live-floating-${kind}-header`);
      const samples = await page.evaluate(() => { const scope = window as any; scope.__sampleSticky = false; return scope.__stickyFrames; });
      for (const frame of samples) assert.deepEqual(frame, baseline, `${stage}: header or active input moved`);
      assert.deepEqual(host.errors, []);
      await captureResult(page, `Live-floating-${kind}-header`);
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Production input presentation stability passed (${observedPaints} compositor paints checked)`);
} catch (error) { console.error('Input presentation failed during:', stage); primaryError = error; throw error; }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
