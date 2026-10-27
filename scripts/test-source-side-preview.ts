import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

async function assertContinuousSourceScroll(page: import('puppeteer-core').Page): Promise<void> {
  const before = await page.$eval('.cm-content', element => {
    const view = (element as any).cmTile.root.view;
    return { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), left: view.scrollDOM.scrollLeft };
  });
  const bounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.x, bounds.y);
  for (const direction of [1, -1]) {
    await page.evaluate(() => {
      const scope = window as any;
      scope.__continuousSourceScroll = { active: true, samples: [] };
      const probe = scope.__continuousSourceScroll;
      const sample = () => {
        if (!probe.active) return;
        probe.samples.push({ source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
          preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop });
        requestAnimationFrame(sample);
      };
      sample();
    });
    // Small trusted deltas expose the line-boundary sawtooth that coarse wheels skip.
    for (let index = 0; index < 30; index++) {
      await page.mouse.wheel({ deltaY: direction * 7 });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 350));
    const samples = await page.evaluate(() => {
      const probe = (window as any).__continuousSourceScroll;
      probe.active = false;
      return probe.samples as Array<{ source: number; preview: number }>;
    });
    assert.ok((samples.at(-1)!.source - samples[0]!.source) * direction > 100, 'The native Source wheel must actually move');
    assert.ok((samples.at(-1)!.preview - samples[0]!.preview) * direction > 2, 'Preview must follow the compressed HTML block');
    assert.ok(samples.every((sample, index) => index === 0
      || (sample.preview - samples[index - 1]!.preview) * direction >= -1),
    `Preview must not rebound during continuous Source scrolling (${direction}): ${JSON.stringify(samples)}`);
  }
  const after = await page.$eval('.cm-content', element => {
    const view = (element as any).cmTile.root.view;
    return { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), left: view.scrollDOM.scrollLeft };
  });
  assert.deepEqual(after, before, 'Linked scrolling preserves Source contents, selection and horizontal position');
}

async function assertColdSourceScroll(page: import('puppeteer-core').Page, windowed: boolean): Promise<void> {
  // Jump directly over unmeasured wrapped lines and unloaded Preview windows.
  await page.locator('.cm-content').click();
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return scroller.scrollTop > 1000 && doc.scrollingElement!.scrollTop > 1000
      && [...doc.querySelectorAll('main.meo-export-doc > *')].some(element => {
        if (element.hasAttribute('data-meo-preview-gap')) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
      });
  });
  const before = await page.$eval('.cm-content', element => {
    const view = (element as any).cmTile.root.view;
    return { text: view.state.doc.toString(), selection: view.state.selection.toJSON() };
  });
  const bounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.x, bounds.y);
  for (const direction of [-1, 1]) {
    await page.evaluate(windowed => {
      const scope = window as any;
      const probe = scope.__coldSourceScroll = { active: true, samples: [] };
      const sample = () => {
        if (!probe.active) return;
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const visible = windowed ? [...doc.querySelectorAll('main.meo-export-doc p')].map(element => {
          const paragraph = /Paragraph (\d+) with/.exec(element.textContent ?? '');
          const rect = element.getBoundingClientRect();
          return paragraph && rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight
            ? { paragraph: Number(paragraph[1]), top: rect.top } : null;
        }).find(Boolean) : null;
        probe.samples.push({ source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
          preview: doc.scrollingElement!.scrollTop, time: performance.now(),
          mounted: doc.querySelectorAll('[data-meo-preview-block]').length, visible });
        requestAnimationFrame(sample);
      };
      sample();
    }, windowed);
    for (let index = 0; index < 12; index++) {
      await page.mouse.wheel({ deltaY: direction * 180 });
      await new Promise(resolve => setTimeout(resolve, 45));
    }
    await new Promise(resolve => setTimeout(resolve, 350));
    const samples = await page.evaluate(() => {
      const probe = (window as any).__coldSourceScroll;
      probe.active = false;
      return probe.samples as Array<{ source: number; preview: number; time: number; mounted: number;
        visible: { paragraph: number; top: number } | null }>;
    });
    assert.ok((samples.at(-1)!.source - samples[0]!.source) * direction > 1000,
      'The cold Source wheel must actually traverse unmeasured text');
    assert.ok((samples.at(-1)!.preview - samples[0]!.preview) * direction > 500,
      'Preview must follow the cold Source gesture');
    if (windowed) {
      // Replacing estimated gaps can move the document's pixel origin while
      // keeping the visible paragraph fixed. Gate actual reading movement with
      // the same one-pixel tolerance, including every intermediate frame.
      assert.ok(samples.every(sample => sample.visible), 'Cold windows must keep visible reading content');
      assert.ok(samples.every((sample, index) => {
        if (index === 0) return true;
        const before = samples[index - 1]!.visible!, after = sample.visible!;
        return after.paragraph === before.paragraph
          ? (before.top - after.top) * direction >= -1
          : (after.paragraph - before.paragraph) * direction > 0;
      }), `Cold windowed reading must not rebound (${direction}): ${JSON.stringify(samples)}`);
    } else {
      assert.ok(samples.every((sample, index) => index === 0
        || (sample.preview - samples[index - 1]!.preview) * direction >= -1),
      `Cold Source scrolling must not rebound (${windowed}/${direction}): ${JSON.stringify(samples)}`);
    }
    if (windowed) assert.ok(samples.every(sample => sample.mounted > 0 && sample.mounted < 150),
      'Cold scrolling must keep bounded Preview windows');
    const gaps = samples.slice(1).map((sample, index) => sample.time - samples[index]!.time).sort((a, b) => a - b);
    console.log(`Cold split scroll (${windowed ? 'windowed' : 'ordinary'}, ${direction}): ${samples.length} frames, p95 ${gaps[Math.floor(gaps.length * 0.95)]!.toFixed(1)}ms`);
  }
  const after = await page.$eval('.cm-content', element => {
    const view = (element as any).cmTile.root.view;
    return { text: view.state.doc.toString(), selection: view.state.selection.toJSON() };
  });
  assert.deepEqual(after, before, 'Cold linked scrolling preserves the complete Source text and selection');
  // The same heading must align after a new explicit Source navigation.
  const headingLine = before.text.slice(0, before.text.indexOf('## Cold alignment target')).split('\n').length;
  await page.locator('.line-jump-input').fill(String(headingLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(line => [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    .some(element => Number(element.textContent) === line), {}, headingLine);
  // This separate alignment probe starts after the line-jump transaction has
  // settled. The cold wheel sequence above deliberately keeps its first frames.
  await page.evaluate(async line => {
    let previous = '', stable = 0;
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const view = (document.querySelector('.cm-content') as any).cmTile.root.view;
      const top = view.lineBlockAt(view.state.doc.line(line).from).top;
      const current = `${view.scrollDOM.scrollTop}:${top}`;
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 3) return;
      previous = current;
    }
    throw new Error('The explicit Source navigation did not settle');
  }, headingLine);
  const delta = await page.evaluate(line => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const view = (document.querySelector('.cm-content') as any).cmTile.root.view;
    return view.lineBlockAt(view.state.doc.line(line).from).top - scroller.scrollTop;
  }, headingLine);
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.wheel({ deltaY: delta });
  await page.waitForFunction(line => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const heading = doc.querySelector<HTMLElement>(`h2[data-source-line="${line}"]`);
    return heading && Math.abs(heading.getBoundingClientRect().top) <= 2;
  }, { timeout: 2000 }, headingLine).catch(async error => {
    console.error('Cold heading alignment', await page.evaluate(line => {
      const view = (document.querySelector('.cm-content') as any).cmTile.root.view;
      const heading = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>(`h2[data-source-line="${line}"]`);
      return { source: view.scrollDOM.scrollTop, target: view.lineBlockAt(view.state.doc.line(line).from).top,
        preview: heading?.getBoundingClientRect().top, line };
    }, headingLine));
    throw error;
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  const settledHeading = await page.evaluate(line => {
    const heading = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>(`h2[data-source-line="${line}"]`);
    return heading?.getBoundingClientRect().top ?? null;
  }, headingLine);
  assert.ok(settledHeading !== null && Math.abs(settledHeading) <= 2,
    `A cold window commit must retain the aligned Source destination: ${settledHeading}`);
}

async function assertScrollContinuityAndAlignment(page: import('puppeteer-core').Page, bundle: string, windowed: boolean): Promise<void> {
  const text = '<div>\n' + Array.from({ length: 40 }, () => '<span>word</span>').join('\n') + '\n</div>\n\n'
    + Array.from({ length: windowed ? 5000 : 300 }, (_, index) =>
      `${index === 150 ? '## Cold alignment target\n\n' : ''}Paragraph ${index} with **formatting** ${'and variable wrapped source context '.repeat(index % 7 + 1)}.\n\n`).join('');
  assert.equal(assessLargeDocument(text).windowedPreview, windowed);
  const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.setViewport({ width: 1200, height: 760 });
    await page.bringToFront();
    await page.exposeFunction('__windowedAlignmentHost', async (message: any) => {
      if (message.type === 'requestPreviewRender') {
        assert.equal(Boolean(message.window), windowed, 'the real Webview must use the assessed Preview path');
        if (!message.window) return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
          value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: '/fixture/alignment.md', uiLanguage: 'en' }) } };
        const parsed = createPreviewDocument(message.requestId, {
          markdownText: message.text, sourceDocumentPath: '/fixture/alignment.md', uiLanguage: 'en'
        });
        documents.set(message.requestId, parsed);
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: parsed.open(message.window.anchorLine) } };
      }
      if (message.type === 'requestPreviewDocument') {
        return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
          result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
      }
      return null;
    });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addScriptTag({ content: `window.__alignmentMessages=[];window.__alignmentState={sourcePreviewScrollSyncEnabled:false};window.acquireVsCodeApi=()=>({getState(){return window.__alignmentState},setState(state){window.__alignmentState=state},postMessage(message){
      window.__alignmentMessages.push({type:message.type,window:message.window});
      const gate=window.__alignmentPause&&message.type==='requestPreviewDocument'&&message.operation.kind==='blocks'&&message.operation.indices.some(index=>index>1000);
      const ready=gate?new Promise(resolve=>{window.__alignmentStarted=true;window.__alignmentRelease=resolve}):Promise.resolve();
      ready.then(()=>window.__windowedAlignmentHost(message)).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}))});
    }});` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///windowed-alignment.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'source', uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark',
      previewFontFamily: '', previewSourceColoring: false, editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } })), text);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar')
      && !document.querySelector<HTMLButtonElement>('.source-preview-button')?.disabled
      && !document.querySelector('.mode-group [aria-busy="true"]') && !document.querySelector('.editor-host')?.hasAttribute('inert'));
    await page.click('.source-preview-button');
    await page.waitForFunction(windowed => {
      const document = globalThis.document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return document?.querySelector('main.meo-export-doc') && (!windowed || document.querySelector('[data-meo-preview-block]'));
    }, {}, windowed);
    await page.waitForFunction(() => {
      const surface = document.querySelector('.editor-surface');
      const host = document.querySelector<HTMLElement>('.preview-host');
      const editor = document.querySelector<HTMLElement>('.editor-host');
      return surface?.hasAttribute('data-source-preview') && !surface.hasAttribute('data-source-preview-preparing')
        && host?.hidden === false && getComputedStyle(host).visibility !== 'hidden' && editor?.inert === false;
    }, { timeout: 2000 });
    if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') !== 'true')) {
      await page.locator('.source-preview-scroll-sync-button').click();
    }
    await page.waitForFunction(() => document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed') === 'true');
    await assertContinuousSourceScroll(page);
    await assertColdSourceScroll(page, windowed);
    if (!windowed) {
      assert.deepEqual(errors, [], 'Ordinary linked scrolling must not throw browser errors');
      return;
    }
    if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true')) {
      await page.locator('.source-preview-scroll-sync-button').click();
    }
    await page.waitForFunction(() => document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed') === 'false');
    await page.evaluate(() => {
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0;
    });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
      .contentDocument!.querySelector('[data-meo-preview-block="0"]'));
    await page.evaluate(() => {
      const scope = window as any, scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.5;
      scope.__alignmentPause = true; scope.__alignmentFrames = [];
      scope.__alignmentSampling = true;
      const sample = () => {
        if (!scope.__alignmentSampling) return;
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        scope.__alignmentFrames.push([...doc.querySelectorAll('[data-meo-preview-block]')].some(element => {
          const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
        }));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator('[data-meo-align-viewport="preview"]').click();
    await page.waitForFunction(() => (window as any).__alignmentStarted);
    const waitingTop = await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      return document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop;
    });
    assert.equal(waitingTop, 0, 'the real alignment arrow must not use estimated geometry to jump into an unloaded gap');
    await page.evaluate(() => { const scope = window as any; scope.__alignmentPause = false; scope.__alignmentRelease(); });
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return doc.scrollingElement!.scrollTop > 1000 && [...doc.querySelectorAll('[data-meo-preview-block]')].some(element => {
        const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight;
      });
    });
    assert.ok(await page.evaluate(() => { const scope = window as any; scope.__alignmentSampling = false; return scope.__alignmentFrames.every(Boolean); }),
      'the real split-preview alignment must keep content painted in every sampled frame');
    const sourceSelection = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      doc.body.tabIndex = -1; doc.body.focus({ preventScroll: true });
      return (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.selection.toJSON();
    });
    await page.locator('[data-meo-align-viewport="source"]').click();
    const alignedFocus = await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
      return { previewFocused: document.activeElement === document.querySelector('.preview-frame'),
        selection: (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.selection.toJSON() };
    });
    assert.deepEqual(alignedFocus, { previewFocused: true, selection: sourceSelection },
      'windowed Preview alignment retains its focus and the Source selection');
    await page.evaluate(() => {
      const scope = window as any, scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.8;
      scope.__alignmentPause = true; scope.__alignmentStarted = false;
    });
    await page.locator('[data-meo-align-viewport="preview"]').click();
    await page.waitForFunction(() => (window as any).__alignmentStarted);
    await page.click('.mode-group [data-mode="live"]');
    await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor')?.classList.contains('meo-mode-live')
      && !document.querySelector('.editor-host')?.hasAttribute('inert'));
    await page.evaluate(async () => {
      const scope = window as any; scope.__alignmentPause = false; scope.__alignmentRelease();
      for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    });
    assert.ok(await page.$eval('.preview-host', element => (element as HTMLElement).hidden), 'the late alignment must leave Live active');
    assert.equal(await page.$eval('.editor-host > .cm-editor .cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text);
    assert.deepEqual(errors, [], 'the complete button/transition path must not throw browser errors');
  } catch (error) {
    console.error('Windowed alignment failed', JSON.stringify({ errors, documents: documents.size, state: await page.evaluate(() => ({
      messages: (window as any).__alignmentMessages, hidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
      pressed: document.querySelector('.source-preview-button')?.getAttribute('aria-pressed'),
      notice: document.querySelector('.meo-editor-notice')?.textContent,
      sync: document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed'),
      alignment: document.querySelector('[data-meo-align-viewport="preview"]')?.outerHTML
    })) }));
    throw error;
  } finally {
    for (const parsed of documents.values()) parsed.dispose();
    await page.close();
  }
}

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (async (predicate: any, options: any, ...args: any[]) => {
    try { return await waitForFunction(predicate, options, ...args); }
    catch (error) {
      throw new Error(`Source side Preview wait failed: ${String(predicate)}`, { cause: error });
    }
  }) as typeof page.waitForFunction;
  if (!process.argv.includes('--windowed-only')) {
  await page.setViewport({ width: 1200, height: 760 });
  let previewRenderCount = 0;
  let nextPreviewRenderDelayMs = 0;
  await page.exposeFunction('__renderSourceSidePreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    previewRenderCount += 1;
    const delayMs = nextPreviewRenderDelayMs;
    nextPreviewRenderDelayMs = 0;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-side-preview.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.exposeFunction('__delayNextSourceSidePreviewRender', (delayMs: number) => {
    nextPreviewRenderDelayMs = Math.max(0, delayMs);
  });
  await page.exposeFunction('__getSourceSidePreviewRenderCount', () => previewRenderCount);
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.__sourceSideMessages=[];window.__sourceSideReloadId=0;window.__sourceSideUiState={sourcePreviewScrollSyncEnabled:false};window.acquireVsCodeApi=()=>({getState(){return window.__sourceSideUiState},setState(state){window.__sourceSideUiState=state},postMessage(message){window.__sourceSideMessages.push(message);if(message.type==='reloadDocumentFromDisk'){const reloadId=++window.__sourceSideReloadId;setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'documentReloadedFromDisk',reloadId,version:reloadId+1,text:window.__sourceSideDiskText,topLine:message.topLine,topLineOffset:message.topLineOffset}})),0);return;}window.__renderSourceSidePreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const compactComplexBlock = [
    '<details>',
    '<summary>Compact complex block</summary>',
    ...Array.from({ length: 36 }, (_, index) => `<p>Collapsed source row ${index + 1}</p>`),
    '</details>'
  ].join('\n');
  const narrowTable = [
    '| A | Content-heavy column | C | D | E | F | G | H | I |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | This column needs materially more room than the compact labels | 3 | 4 | 5 | 6 | 7 | 8 | 9 |'
  ].join('\n');
  const reportedTable = [
    '| asd | asd | asd | asd | |',
    '| --- | --- | --- | --- | --- |',
    '| **asd**332 | *asd* | ~~asd~~ | `asd` | #asd |',
    '| asd | asd | asd | sadasd | sadasd |',
    '| | | | [linked cell](https://example.com/)LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL | |',
    '| - asd | | | | |'
  ].join('\n');
  const structuredMappingBlock = [
    '## Structured mapping fixture',
    '',
    '- Apple',
    '- Banana',
    '  - Banana milk',
    '  - Banana cake',
    '    - Deep nested item',
    '      - Deeper nested item with `code`',
    '',
    'Ordered list:',
    '',
    ...Array.from({ length: 20 }, (_, index) => `${index + 1}. Ordered item ${index + 1}`),
    '   1. Nested ordered item',
    '',
    'Task list:',
    '',
    '- [x] Completed task',
    '- [ ] Pending task',
    '- [ ] Task with **formatting** and `code`',
    '- [x] Task with a displaced footnote[^mapping-note]',
    '',
    '[^mapping-note]: Footnote definitions render outside their source position.',
    '',
    'Mixed list:',
    '',
    '1. First ordered item',
    '   - Nested unordered item',
    '   - Nested task item',
    '     - [ ] Child task',
    '2. Second ordered item',
    '   > Quote in list',
    '   >',
    '   > ```js',
    '   > console.log("code in quote in list");',
    '   > ```',
    '3. Third ordered item',
    '',
    '## Structured mapping end',
    '',
    'The content after the structured range must align on both surfaces.'
  ].join('\n');
  const highlightedCodeBlock = [
    '## Highlight continuity fixture',
    '',
    '```typescript',
    'const previewHighlight = "before";',
    '```'
  ].join('\n');
  const rawHtmlTable = [
    '<table>',
    '  <thead><tr><th>HTML type</th><th>Expected behavior</th><th>Interaction</th></tr></thead>',
    '  <tbody>',
    '    <tr><td>Inline style</td><td>Embedded ordinary text</td><td>Edit current line</td></tr>',
    '    <tr><td>Link</td><td>Always shows navigation target</td><td>Click target</td></tr>',
    '    <tr><td>Block HTML</td><td>No card background</td><td>Source button edits</td></tr>',
    '  </tbody>',
    '</table>'
  ].join('\n');
  const modeTable = [
    '| Mode row | Content |',
    '| --- | --- |',
    ...Array.from({ length: 14 }, (_, index) => (
      `| Mode row ${index + 1} | Complex table content ${index + 1} |`
    ))
  ].join('\n');
  const text = [
    'Intro paragraph for formatting continuity.',
    highlightedCodeBlock,
    `### Long heading ${'6'.repeat(180)}`,
    '',
    `Ordinary paragraph ${'7'.repeat(220)}`,
    '',
    `- Ordinary list item ${'unbroken'.repeat(55)}`,
    ...Array.from({ length: 22 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to exercise semantic linked scrolling.`
    )),
    compactComplexBlock,
    narrowTable,
    reportedTable,
    rawHtmlTable,
    modeTable,
    structuredMappingBlock,
    ...Array.from({ length: 118 }, (_, index) => {
      const section = index + 23;
      return `## Section ${section}\n\nParagraph ${section} with enough text to exercise semantic linked scrolling.`;
    })
  ].join('\n\n');
  await page.evaluate(text => {
    (window as any).__sourceSideDiskText = text;
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///source-side-preview.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
      uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
      previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } }));
  }, text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.source-preview-button');
    if (!button || button.closest('.meo-preload-toolbar') || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    return button.offsetParent !== null && getComputedStyle(button).visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  });
  const preloadCount = previewRenderCount;

  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && preview?.contentDocument?.body.textContent?.includes('Section 140')
      && document.querySelector<HTMLElement>('.preview-loading')?.hidden
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden';
  });
  const layout = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    const button = document.querySelector<HTMLButtonElement>('.source-preview-button')!;
    const syncButton = document.querySelector<HTMLButtonElement>('.source-preview-scroll-sync-button')!;
    const previewRect = preview.getBoundingClientRect();
    const syncRect = syncButton.getBoundingClientRect();
    return {
      editorWidth: editor.getBoundingClientRect().width,
      previewWidth: preview.getBoundingClientRect().width,
      editorVisible: !editor.hidden,
      previewVisible: !preview.hidden,
      pressed: button.getAttribute('aria-pressed'),
      label: button.textContent?.trim(),
      syncPressed: syncButton.getAttribute('aria-pressed'),
      syncVisible: syncButton.offsetParent !== null,
      splitIcon: button.querySelector('svg')?.getAttribute('data-icon'),
      syncIcon: syncButton.querySelector('svg')?.getAttribute('data-icon'),
      scrollTopIcons: Array.from(document.querySelectorAll<SVGElement>('.document-scroll-top svg'))
        .map(icon => icon.getAttribute('data-icon')),
      syncIconSize: syncButton.querySelector('svg')?.getBoundingClientRect().width,
      syncBorderRadius: getComputedStyle(syncButton).borderRadius,
      syncBorderWidth: getComputedStyle(syncButton).borderTopWidth,
      syncBoxShadow: getComputedStyle(syncButton).boxShadow,
      syncSize: { width: syncRect.width, height: syncRect.height },
      syncOffset: {
        left: syncRect.left - previewRect.left,
        top: syncRect.top - previewRect.top
      },
      focusedInEditor: editor.contains(document.activeElement)
    };
  });
  assert.equal(layout.editorVisible, true);
  assert.equal(layout.previewVisible, true);
  assert.equal(layout.pressed, 'true');
  assert.equal(layout.label, '');
  assert.equal(
    layout.syncPressed,
    'true',
    'A newly opened document session must ignore stale persisted scroll-sync state'
  );
  assert.equal(layout.syncVisible, true);
  assert.equal(layout.splitIcon, 'open-preview');
  assert.equal(layout.syncIcon, 'link');
  assert.deepEqual(layout.scrollTopIcons, ['arrow-up-to-line', 'arrow-up-to-line']);
  assert.equal(layout.syncIconSize, 14);
  assert.equal(layout.syncBorderRadius, '50%');
  assert.equal(layout.syncBorderWidth, '1px');
  assert.equal(layout.syncBoxShadow, 'none');
  assert.deepEqual(layout.syncSize, { width: 20, height: 20 });
  assert.ok(layout.syncOffset.left >= 2 && layout.syncOffset.left <= 4, JSON.stringify(layout));
  assert.ok(Math.abs(layout.syncOffset.top - 2) <= 0.5, JSON.stringify(layout));
  assert.equal(layout.focusedInEditor, true, 'Opening side Preview should restore editor focus');
  assert.ok(Math.abs(layout.editorWidth - layout.previewWidth) <= 2, JSON.stringify(layout));
  await page.click('.source-preview-more-button');
  const sideTools = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.source-preview-more-panel')!;
    const sync = document.querySelector<HTMLElement>('.source-preview-scroll-sync-button')!;
    const more = document.querySelector<HTMLElement>('.source-preview-more-button')!;
    return {
      expanded: more.getAttribute('aria-expanded'),
      open: !panel.hidden,
      rows: Array.from(panel.children, child => child.querySelector('.preview-select-label')?.textContent),
      hasExport: !!panel.querySelector('.preview-export-control'),
      belowSync: more.getBoundingClientRect().top >= sync.getBoundingClientRect().bottom,
      icon: more.querySelector('svg')?.getAttribute('data-icon'),
      text: more.textContent,
      size: { width: more.getBoundingClientRect().width, height: more.getBoundingClientRect().height },
      borderRadius: getComputedStyle(more).borderRadius,
      boxShadow: getComputedStyle(more).boxShadow,
      controlsVisible: Array.from(panel.children, child => (child as HTMLElement).offsetParent !== null),
      editorFocused: document.activeElement === document.querySelector('.cm-content')
    };
  });
  assert.deepEqual(sideTools, {
    expanded: 'true', open: true,
    rows: ['Preview preset', 'Preview theme', 'Body font', 'Code font', 'Width', 'Code color', 'HTML comments'],
    hasExport: false, belowSync: true, icon: 'ellipsis', text: '',
    size: { width: 20, height: 20 }, borderRadius: '50%', boxShadow: 'none',
    controlsVisible: [true, true, true, true, true, true, true], editorFocused: true
  });
  await page.click('.source-preview-more-button');
  assert.equal(await page.$eval('.source-preview-more-panel', panel => (panel as HTMLElement).hidden), true);
  const tableFit = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Array.from(frameDocument.querySelectorAll<HTMLTableElement>('table')).map(table => {
      const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block')!;
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('col'));
      const lastCells = Array.from(table.rows)
        .map(row => row.cells.item(row.cells.length - 1))
        .filter((cell): cell is HTMLTableCellElement => cell !== null);
      return {
        wrapperClass: wrapper.className,
        wrapperClientWidth: wrapper.clientWidth,
        tableStyleWidth: table.style.width,
        tableRectWidth: tableRect.width,
        overflow: wrapper.scrollWidth - wrapper.clientWidth,
        overflowX: getComputedStyle(wrapper).overflowX,
        rightOverflow: tableRect.right - wrapperRect.right,
        rightSafetyInset: wrapperRect.right - tableRect.right,
        viewportRightOverflow: tableRect.right - frameDocument.documentElement.clientWidth,
        lastCellRightOverflow: Math.max(
          Number.NEGATIVE_INFINITY,
          ...lastCells.map(cell => cell.getBoundingClientRect().right - frameDocument.documentElement.clientWidth)
        ),
        widths: columns.map(column => column.getBoundingClientRect().width)
      };
    });
  });
  assert.ok(tableFit.length >= 2, JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.overflow <= 0.5), JSON.stringify(tableFit));
  assert.ok(
    tableFit.every(table => table.overflowX === 'clip' || table.overflowX === 'hidden'),
    JSON.stringify(tableFit)
  );
  assert.ok(tableFit.every(table => table.rightOverflow <= 0.5), JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.viewportRightOverflow <= -0.75), JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.lastCellRightOverflow <= -0.75), JSON.stringify(tableFit));
  assert.ok(tableFit[0].widths[1] > tableFit[0].widths[0], JSON.stringify(tableFit));

  const transitionTableStartLine = text.slice(0, text.indexOf('| asd | asd | asd | asd | |')).split('\n').length;
  const transitionTableAnchorLine = transitionTableStartLine + 2;
  const alignSourceLineAtReadingBand = async (lineNumber: number) => {
    await page.click('.line-jump-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(lineNumber));
    await page.keyboard.press('Enter');
    await page.waitForFunction(line => Array.from(
      document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
    ).some(element => Number(element.textContent) === line), {}, lineNumber);
    await page.evaluate(line => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const gutter = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
        .find(element => Number(element.textContent) === line)!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += gutter.getBoundingClientRect().top - viewport.top - viewport.height / 3;
    }, lineNumber);
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const waitForPreviewTransition = async (mode: 'source' | 'preview') => {
    await page.waitForFunction(expectedMode => {
      const app = document.querySelector<HTMLElement>('#app');
      const surface = document.querySelector<HTMLElement>('.editor-surface');
      const preview = document.querySelector<HTMLElement>('.preview-host');
      const editor = document.querySelector<HTMLElement>('.editor-host');
      const frame = preview?.querySelector<HTMLIFrameElement>('.preview-frame');
      if (app?.dataset.mode !== expectedMode || !surface || !preview || !editor
        || preview.hidden || preview.inert || getComputedStyle(preview).visibility === 'hidden'
        || preview.querySelector<HTMLElement>('.preview-loading')?.hidden === false
        || frame?.contentDocument?.documentElement.inert !== false) return false;
      return expectedMode === 'source'
        ? surface.hasAttribute('data-source-preview') && !surface.hasAttribute('data-source-preview-preparing')
          && !editor.hidden && !editor.inert
        : editor.hidden && !editor.hasAttribute('data-preview-cover');
    }, { timeout: 2_000 }, mode);
  };
  const startPreviewAnchorSampling = async (lineNumber: number) => page.evaluate(async line => {
    const samples: Array<{
      started: boolean;
      mode: string;
      covered: boolean;
      visible: boolean;
      offset: number | null;
      scrollTop: number;
      editorScrollTop?: number;
      width: number;
      split: boolean;
      editorVisible: boolean;
      editorOffset: number | null;
      editorWidth: number;
    }> = [];
    let active = true;
    let started = false;
    const sample = () => {
      if (!active) return;
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameDocument = frame.contentDocument!;
      const editorHost = document.querySelector<HTMLElement>('.editor-host')!;
      const editorScroller = document.querySelector<HTMLElement>('.cm-scroller');
      const editorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
        .find(element => Number(element.textContent) === line);
      const editorViewport = editorScroller?.getBoundingClientRect() ?? null;
      const editorLineRect = editorLine?.getBoundingClientRect() ?? null;
      const viewportOffset = frameDocument.documentElement.clientHeight / 3;
      const projection = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => {
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          return start <= line && end >= line;
        })
        .map(element => {
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          const rect = element.getBoundingClientRect();
          const ratio = (line - start) / Math.max(1, end - start + 1);
          return {
            offset: rect.top + rect.height * ratio - viewportOffset,
            span: end - start,
            height: rect.height
          };
        })
        .sort((left, right) => left.span - right.span || left.height - right.height)[0];
      samples.push({
        started,
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode ?? '',
        covered: document.querySelector<HTMLElement>('.editor-host')?.hasAttribute('data-preview-cover') ?? false,
        visible: !host.hidden && getComputedStyle(host).visibility !== 'hidden'
          && host.querySelector<HTMLElement>('.preview-loading')?.hidden !== false,
        offset: projection?.offset ?? null,
        scrollTop: frameDocument.scrollingElement?.scrollTop ?? 0,
        editorScrollTop: editorScroller?.scrollTop,
        width: frame.getBoundingClientRect().width,
        split: document.querySelector('.editor-surface')?.hasAttribute('data-source-preview') ?? false,
        editorVisible: getComputedStyle(editorHost).display !== 'none'
          && getComputedStyle(editorHost).visibility !== 'hidden',
        editorOffset: editorViewport && editorLineRect
          ? editorLineRect.top - editorViewport.top - editorViewport.height / 3
          : null,
        editorWidth: editorHost.getBoundingClientRect().width
      });
      requestAnimationFrame(sample);
    };
    (window as typeof window & {
      __previewModeAnchorProbe?: { samples: typeof samples; markStarted(): void; stop(): void };
    }).__previewModeAnchorProbe = {
      samples,
      markStarted: () => { started = true; },
      stop: () => { active = false; }
    };
    // Establish a real pre-transition frame before the caller can markStarted.
    await new Promise<void>(resolve => requestAnimationFrame(() => { sample(); resolve(); }));
  }, lineNumber);
  const stopPreviewAnchorSampling = async () => page.evaluate(() => {
    const probe = (window as typeof window & {
      __previewModeAnchorProbe: {
        samples: Array<{
          started: boolean;
          mode: string;
          covered: boolean;
          visible: boolean;
          offset: number | null;
          scrollTop: number;
          width: number;
          split: boolean;
          editorVisible: boolean;
          editorOffset: number | null;
          editorWidth: number;
        }>;
        stop(): void;
      };
    }).__previewModeAnchorProbe;
    probe.stop();
    return probe.samples;
  });
  const startEditorAnchorSampling = async (anchorText: string) => page.evaluate(async text => {
    const samples: Array<{
      started: boolean;
      mode: string;
      previewVisible: boolean;
      editorVisible: boolean;
      offset: number | null;
      scrollTop: number;
      width: number;
    }> = [];
    let active = true;
    let started = false;
    const sample = () => {
      if (!active) return;
      const previewHost = document.querySelector<HTMLElement>('.preview-host')!;
      const editorHost = document.querySelector<HTMLElement>('.editor-host')!;
      const scroller = document.querySelector<HTMLElement>('.cm-scroller');
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find(candidate => candidate.textContent?.includes(text));
      const viewport = scroller?.getBoundingClientRect() ?? null;
      const lineRect = line?.getBoundingClientRect() ?? null;
      samples.push({
        started,
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode ?? '',
        previewVisible: !previewHost.hidden && getComputedStyle(previewHost).visibility !== 'hidden',
        editorVisible: !editorHost.hidden && getComputedStyle(editorHost).visibility !== 'hidden',
        offset: viewport && lineRect ? lineRect.top - viewport.top : null,
        scrollTop: scroller?.scrollTop ?? 0,
        width: editorHost.getBoundingClientRect().width
      });
      requestAnimationFrame(sample);
    };
    (window as typeof window & {
      __editorModeAnchorProbe?: { samples: typeof samples; markStarted(): void; stop(): void };
    }).__editorModeAnchorProbe = {
      samples,
      markStarted: () => { started = true; },
      stop: () => { active = false; }
    };
    // The first frame belongs to the state before the caller's mode change.
    await new Promise<void>(resolve => requestAnimationFrame(() => { sample(); resolve(); }));
  }, anchorText);
  const stopEditorAnchorSampling = async () => page.evaluate(() => {
    const probe = (window as typeof window & {
      __editorModeAnchorProbe: {
        samples: Array<{
          started: boolean;
          mode: string;
          previewVisible: boolean;
          editorVisible: boolean;
          offset: number | null;
          scrollTop: number;
          width: number;
        }>;
        stop(): void;
      };
    }).__editorModeAnchorProbe;
    probe.stop();
    return probe.samples;
  });

  const compactBlockStartLine = text.slice(0, text.indexOf('<details>')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.type(String(compactBlockStartLine));
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 120));
  const compactBlockTrace = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const positions: number[] = [];
    for (let frame = 0; frame < 150; frame += 1) {
      scroller.scrollTop += 6;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(frameDocument.scrollingElement!.scrollTop);
    }
    return positions;
  });
  const compactBlockReverseSteps = compactBlockTrace.filter((position, index) => (
    index > 0 && position < compactBlockTrace[index - 1] - 1
  ));
  assert.equal(
    compactBlockReverseSteps.length,
    0,
    `Compact complex blocks must not make linked Preview reverse: ${JSON.stringify(compactBlockTrace)}`
  );
  let longestStationaryPreviewRun = 0;
  let stationaryPreviewRun = 0;
  for (let index = 1; index < compactBlockTrace.length; index += 1) {
    if (Math.abs(compactBlockTrace[index] - compactBlockTrace[index - 1]) <= 0.1) {
      stationaryPreviewRun += 1;
      longestStationaryPreviewRun = Math.max(longestStationaryPreviewRun, stationaryPreviewRun);
    } else {
      stationaryPreviewRun = 0;
    }
  }
  assert.ok(
    longestStationaryPreviewRun <= 8,
    `A mapped complex range must not create a long stationary Preview plateau: ${JSON.stringify({ longestStationaryPreviewRun, compactBlockTrace })}`
  );
  const structuredTargets = [
    'Deeper nested item with',
    'Ordered item 6',
    'Ordered item 14',
    'Pending task',
    'Nested unordered item',
    'console.log("code in quote in list")',
    'Structured mapping end'
  ].map(marker => ({
    marker,
    line: text.slice(0, text.indexOf(marker)).split('\n').length
  }));
  const structuredAlignment = [] as Array<{
    marker: string;
    line: number;
    previewOffset: number | null;
    previewRange: [number, number] | null;
    previewHeight: number | null;
    viewportHeight: number;
    sourceOffset: number | null;
  }>;
  for (const target of structuredTargets) {
    await page.click('.line-jump-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(target.line));
    await page.keyboard.press('Enter');
    await page.waitForFunction(marker => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .some(line => line.textContent?.includes(marker)), {}, target.marker);
    await page.evaluate(async marker => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find(candidate => candidate.textContent?.includes(marker))!;
      const viewport = scroller.getBoundingClientRect();
      // Linked projection is driven by the native scroll event. A wall-clock
      // sleep can expire before Chromium delivers it, especially after layout.
      await new Promise<void>(resolve => {
        const afterScroll = () => requestAnimationFrame(() => resolve());
        scroller.addEventListener('scroll', afterScroll, { once: true });
        const previousTop = scroller.scrollTop;
        scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
        if (scroller.scrollTop === previousTop) {
          scroller.removeEventListener('scroll', afterScroll);
          afterScroll();
        }
      });
    }, target.marker);
    structuredAlignment.push(await page.evaluate(({ marker, line }) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameDocument = frame.contentDocument!;
      const readingBand = frameDocument.documentElement.clientHeight / 3;
      const candidates = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => {
          if (element.hasAttribute('data-meo-preview-gap')) return false;
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          return start <= line && end >= line;
        })
        .map(element => {
          const rect = element.getBoundingClientRect();
          return {
            offset: rect.top - readingBand,
            range: [Number(element.dataset.sourceLine), Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine)] as [number, number],
            height: rect.height
          };
        })
        .sort((left, right) => Math.abs(left.offset) - Math.abs(right.offset) || left.height - right.height);
      return {
        marker,
        line,
        previewOffset: candidates[0]?.offset ?? null,
        previewRange: candidates[0]?.range ?? null,
        previewHeight: candidates[0]?.height ?? null,
        viewportHeight: frameDocument.documentElement.clientHeight,
        sourceOffset: (() => {
          const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
          const sourceLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
            .find(element => element.textContent?.includes(marker));
          const bounds = scroller.getBoundingClientRect();
          return sourceLine ? sourceLine.getBoundingClientRect().top - bounds.top - bounds.height / 3 : null;
        })()
      };
    }, target));
  }
  // The cached map aligns scroll origins. Font size and list density can place
  // a source-band item elsewhere inside Preview; a fixed 120px center tolerance
  // rejects valid layouts. Require the actual rendered range to stay visible.
  assert.ok(
    structuredAlignment.every(sample => sample.previewOffset !== null && sample.previewHeight !== null
      && sample.previewOffset + sample.viewportHeight / 3 < sample.viewportHeight
      && sample.previewOffset + sample.viewportHeight / 3 + sample.previewHeight > 0),
    `The same structured source range must remain in the Preview reading band: ${JSON.stringify(structuredAlignment)}`
  );
  const highlightedSourceLine = text.slice(0, text.indexOf('const previewHighlight')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(highlightedSourceLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
      .find(candidate => candidate.textContent?.includes('previewHighlight'));
    const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
    // Cached offscreen colors can precede the linked navigation's completion.
    // Establish a painted reading target before testing update-color continuity.
    const bounds = code?.getBoundingClientRect();
    return bounds && bounds.bottom > 0 && bounds.top < frameDocument!.documentElement.clientHeight
      && sources.length > 0 && sources.every(source => source.dataset.meoShiki && source.querySelector('span[style*="color"]'));
  }, { timeout: 10000 });
  await page.evaluate(() => {
    const samples: Array<{ text: string; highlighted: boolean }> = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
        .find(candidate => candidate.textContent?.includes('previewHighlight'));
      const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
      samples.push({
        text: code?.textContent ?? '',
        highlighted: sources.length > 0
          && sources.every(source => Boolean(source.dataset.meoShiki && source.querySelector('span[style*="color"]')))
      });
      requestAnimationFrame(sample);
    };
    (window as typeof window & {
      __previewHighlightContinuityProbe?: { samples: typeof samples; stop(): void };
    }).__previewHighlightContinuityProbe = { samples, stop: () => { active = false; } };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
      .find(candidate => candidate.textContent?.includes('previewHighlight'));
    const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
    return code?.textContent?.includes(';X')
      && sources.length > 0
      && sources.every(source => source.dataset.meoShiki && source.querySelector('span[style*="color"]'));
  }, { timeout: 10000 });
  const highlightContinuityFrames = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __previewHighlightContinuityProbe: { samples: Array<{ text: string; highlighted: boolean }>; stop(): void };
    }).__previewHighlightContinuityProbe;
    probe.stop();
    return probe.samples;
  });
  assert.ok(
    highlightContinuityFrames.every(frame => !frame.text.includes(';X') || frame.highlighted),
    `Updated code must not become visible before its syntax colors are ready: ${JSON.stringify(highlightContinuityFrames)}`
  );
  const structuredStartLine = text.slice(0, text.indexOf('## Structured mapping fixture')).split('\n').length;
  const structuredEndLine = text.slice(0, text.indexOf('## Structured mapping end')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(structuredStartLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.cm-line')?.isConnected === true);
  const semanticScrollTrace = await page.evaluate(async ({ startLine, endLine }) => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const samples: Array<{ sourceLine: number | null; previewLine: number | null; delta: number | null }> = [];
    for (let step = 0; step <= 100; step += 1) {
      scroller.scrollTop += 12;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const sourceBand = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const sourceLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .filter(entry => entry.rect.bottom >= sourceBand)
        .sort((left, right) => Math.abs(left.rect.top - sourceBand) - Math.abs(right.rect.top - sourceBand))[0]
        ?.element.textContent;
      const previewBand = frameDocument.documentElement.clientHeight / 3;
      const previewCandidates = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .map(element => {
          const rect = element.getBoundingClientRect();
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          const ratio = rect.height > 0 ? Math.max(0, Math.min(1, (previewBand - rect.top) / rect.height)) : 0;
          return {
            contains: rect.top <= previewBand && rect.bottom >= previewBand,
            distance: rect.top <= previewBand ? previewBand - rect.top : rect.top - previewBand,
            height: rect.height,
            line: Math.round(start + (end - start) * ratio)
          };
        })
        .filter(entry => Number.isFinite(entry.line))
        .sort((left, right) => Number(right.contains) - Number(left.contains)
          || (left.contains && right.contains ? left.height - right.height : left.distance - right.distance));
      const parsedSourceLine = Number(sourceLine);
      const previewLine = previewCandidates[0]?.line ?? null;
      if (!Number.isFinite(parsedSourceLine) || parsedSourceLine < startLine || parsedSourceLine > endLine) continue;
      samples.push({
        sourceLine: Number.isFinite(parsedSourceLine) ? parsedSourceLine : null,
        previewLine,
        delta: Number.isFinite(parsedSourceLine) && previewLine !== null
          ? previewLine - parsedSourceLine
          : null
      });
    }
    return samples;
  }, { startLine: structuredStartLine, endLine: structuredEndLine });
  assert.ok(
    semanticScrollTrace.every(sample => sample.delta !== null && Math.abs(sample.delta) <= 12),
    `Linked scrolling must keep the same semantic source range in the reading band: ${JSON.stringify(semanticScrollTrace)}`
  );
  assert.ok(
    tableFit.every(table => table.rightSafetyInset >= 0.75),
    `The final collapsed border needs a visible safety inset: ${JSON.stringify(tableFit)}`
  );

  await page.keyboard.down('Control');
  await page.keyboard.press('Home');
  await page.keyboard.up('Control');
  const countBeforeTyping = previewRenderCount;
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await page.keyboard.type('**Intro**');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(previewRenderCount, countBeforeTyping, 'Preview refresh must yield during active typing');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return frame?.contentDocument?.querySelector('strong')?.textContent === 'Intro';
  }, { timeout: 3000 });
  assert.equal(previewRenderCount, countBeforeTyping + 1, 'A typing burst should coalesce to one render');

  // Input's native caret reveal does not drive Preview. Resume linkage with
  // an actual reading gesture, rather than a synthetic post-edit scroll write.
  const linkedScrollPoint = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    const previewTop = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, previewTop };
  });
  await page.mouse.move(linkedScrollPoint.x, linkedScrollPoint.y);
  await page.mouse.wheel({ deltaY: 1800 });
  await page.waitForFunction(previousTop => {
    const top = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.scrollingElement?.scrollTop ?? 0;
    return top > 200 && Math.abs(top - previousTop) > 1;
  }, {}, linkedScrollPoint.previewTop);

  const refreshScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    const firstText = frameDocument.querySelector('.meo-export-doc')?.firstChild;
    if (firstText) {
      const range = frameDocument.createRange();
      range.selectNodeContents(firstText);
      const selection = frameDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const probe = {
      frameHiddenTransitions: 0,
      editorScrollTops: [] as number[],
      previewScrollTops: [] as number[],
      previewFrames: [] as Array<{
        editorScrollTop: number;
        scrollTop: number;
        sourceLine: number | null;
        anchorTop: number | null;
      }>,
      samplePreviewFrames: false,
      stablePreviewNode: frameDocument.querySelector<HTMLElement>('h2')
    };
    new MutationObserver((records) => {
      if (
        frame.style.visibility === 'hidden' ||
        records.some(record => record.oldValue?.includes('visibility: hidden'))
      ) probe.frameHiddenTransitions += 1;
    }).observe(frame, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    document.querySelector<HTMLElement>('.cm-scroller')!.addEventListener('scroll', () => {
      probe.editorScrollTops.push(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop);
    }, { passive: true });
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
    const samplePreviewFrame = () => {
      if (!probe.samplePreviewFrames) return;
      const currentDocument = frame.contentDocument;
      const scrollTop = currentDocument?.scrollingElement?.scrollTop ?? 0;
      const anchor = Array.from(currentDocument?.querySelectorAll<HTMLElement>('[data-source-line]') ?? [])
        .find((element) => element.getBoundingClientRect().bottom > 0);
      probe.previewFrames.push({
        editorScrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
        scrollTop,
        sourceLine: anchor ? Number(anchor.dataset.sourceLine) : null,
        anchorTop: anchor?.getBoundingClientRect().top ?? null
      });
      requestAnimationFrame(samplePreviewFrame);
    };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .startPreviewFrameSampling = () => {
        probe.previewScrollTops = [];
        probe.previewFrames = [];
        probe.samplePreviewFrames = true;
        requestAnimationFrame(samplePreviewFrame);
      };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .stopPreviewFrameSampling = () => { probe.samplePreviewFrames = false; };
    (window as typeof window & { __sourcePreviewContinuityProbe?: typeof probe }).__sourcePreviewContinuityProbe = probe;
  });
  const sourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + 24
  );
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  const sourceDrivenFrames = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return probe.previewFrames;
  });
  const sourceFollowerLagFrames = sourceDrivenFrames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = sourceDrivenFrames[index - 1];
    return Math.abs(frame.editorScrollTop - previous.editorScrollTop) > 1
      && Math.abs(frame.scrollTop - previous.scrollTop) <= 1;
  });
  assert.equal(
    sourceFollowerLagFrames.length,
    0,
    `Source-driven linked scrolling must update Preview in the same sampled frame: ${JSON.stringify(sourceDrivenFrames)}`
  );
  const sourceDrivenPreviewReverseSteps = sourceDrivenFrames.filter((frame, index) => (
    index > 0 && frame.scrollTop < sourceDrivenFrames[index - 1].scrollTop - 1
  ));
  assert.equal(
    sourceDrivenPreviewReverseSteps.length,
    0,
    `Source-driven Preview must remain monotonic through compact complex blocks: ${JSON.stringify(sourceDrivenFrames)}`
  );
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  const continuityScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  const renderCountBeforeContinuityEdit = previewRenderCount;
  await page.evaluate(() => (
    (window as typeof window & { __delayNextSourceSidePreviewRender(delayMs: number): Promise<void> })
      .__delayNextSourceSidePreviewRender(500)
  ));
  const continuityEdit = 'CONTINUITY';
  await page.keyboard.type(continuityEdit);
  await page.waitForFunction(async count => (
    await (window as typeof window & { __getSourceSidePreviewRenderCount(): Promise<number> })
      .__getSourceSidePreviewRenderCount()
  ) > count, {}, renderCountBeforeContinuityEdit);
  const inFlightPresentation = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const status = document.querySelector<HTMLElement>('.preview-status')!;
    return {
      frameVisibility: frame.style.visibility,
      oldFrameStillVisible: frame.contentDocument?.body.textContent?.includes('Section 140'),
      statusHidden: status.hidden
    };
  });
  await page.waitForFunction(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('CONTINUITY')
  ), { timeout: 3000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const continuity = await page.evaluate((beforeScrollTop) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops: number[];
        previewFrames: Array<{
          editorScrollTop: number;
          scrollTop: number;
          sourceLine: number | null;
          anchorTop: number | null;
        }>;
        stablePreviewNode: HTMLElement | null;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    const editorScrollTop = document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop;
    return {
      ...probe,
      stablePreviewNodePreserved: probe.stablePreviewNode?.isConnected === true
        && frameDocument.querySelector('h2') === probe.stablePreviewNode,
      editorScrollDelta: editorScrollTop - beforeScrollTop,
      documentOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      bodyOverflow: frameDocument.body.scrollWidth - frameDocument.body.clientWidth,
      horizontalScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height
    };
  }, continuityScrollTop);
  assert.deepEqual(inFlightPresentation, {
    frameVisibility: '',
    oldFrameStillVisible: true,
    statusHidden: true
  }, 'An existing Preview must remain unobstructed while its replacement renders');
  assert.equal(continuity.frameHiddenTransitions, 0, 'Preview updates must never hide the current frame');
  assert.equal(continuity.stablePreviewNodePreserved, true, 'Unchanged Preview blocks must survive a live update');
  assert.ok(Math.abs(continuity.editorScrollDelta) <= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.length >= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.every(frame => frame.sourceLine !== null), JSON.stringify(continuity));
  const previewScrollRange = Math.max(...continuity.previewFrames.map(frame => frame.scrollTop))
    - Math.min(...continuity.previewFrames.map(frame => frame.scrollTop));
  assert.ok(previewScrollRange <= 1, JSON.stringify(continuity));
  assert.ok(continuity.documentOverflow <= 1 && continuity.bodyOverflow <= 1, JSON.stringify(continuity));
  assert.equal(continuity.horizontalScrollbarHeight, '0px');

  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    const wide = frameWindow.document.createElement('div');
    wide.className = 'meo-export-html-block';
    wide.dataset.testGenuineHorizontalOverflow = 'true';
    const content = frameWindow.document.createElement('div');
    content.style.width = '1800px';
    content.style.height = '1px';
    wide.append(content);
    frameWindow.document.querySelector('.meo-export-doc')!.append(wide);
    frameWindow.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const overflow = frameDocument?.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]');
    return Boolean(overflow && overflow.scrollWidth - overflow.clientWidth > 500);
  });
  const genuineOverflow = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const localScroller = frameDocument.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]')!;
    return {
      rootOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      rootScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height,
      localOverflow: localScroller.scrollWidth - localScroller.clientWidth,
      localOverflowX: frameDocument.defaultView!.getComputedStyle(localScroller).overflowX
    };
  });
  assert.ok(genuineOverflow.localOverflow > 500, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.localOverflowX, 'auto');
  assert.ok(genuineOverflow.rootOverflow <= 1, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.rootScrollbarHeight, '0px');
  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    frameWindow.document.querySelector('[data-test-genuine-horizontal-overflow]')?.remove();
    frameWindow.dispatchEvent(new Event('resize'));
  });

  // Keep the caret inside the currently rendered Source viewport so this check
  // observes selection movement rather than CodeMirror virtualizing an old,
  // off-screen DOM selection left by an earlier fixture phase.
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  const selectionBefore = await page.evaluate(() => {
    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const line = anchorNode instanceof Element
      ? anchorNode.closest<HTMLElement>('.cm-line')
      : anchorNode?.parentElement?.closest<HTMLElement>('.cm-line');
    if (!selection || !anchorNode || !line) return null;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(anchorNode, selection.anchorOffset);
    return { lineText: line.textContent, offset: range.toString().length };
  });
  const frameBounds = await page.$eval('.preview-frame', frame => {
    const rect = frame.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const editorScrollBefore = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops?: number[];
        startPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.editorScrollTops = [];
    probe.previewScrollTops = [];
    probe.startPreviewFrameSampling();
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops!.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
  });
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await page.waitForFunction(previous => (
    Math.abs(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop - previous) > 100
  ), { timeout: 3000 }, editorScrollBefore);
  const selectionAfter = await page.evaluate(() => {
    document.querySelector<HTMLElement>('.cm-content')?.focus({ preventScroll: true });
    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const line = anchorNode instanceof Element
      ? anchorNode.closest<HTMLElement>('.cm-line')
      : anchorNode?.parentElement?.closest<HTMLElement>('.cm-line');
    if (!selection || !anchorNode || !line) return null;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(anchorNode, selection.anchorOffset);
    return { lineText: line.textContent, offset: range.toString().length };
  });
  assert.deepEqual(selectionAfter, selectionBefore, 'Preview-driven scroll must not move Source selection');
  const scrollTrace = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        editorScrollTops: number[];
        previewScrollTops?: number[];
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return {
      editor: probe.editorScrollTops,
      preview: probe.previewScrollTops ?? [],
      frames: probe.previewFrames
    };
  });
  const hasReverseStep = (values: number[]) => values.some((value, index) => (
    index > 0 && value < values[index - 1] - 1
  ));
  assert.equal(hasReverseStep(scrollTrace.preview), false, JSON.stringify(scrollTrace));
  assert.equal(hasReverseStep(scrollTrace.editor), false, JSON.stringify(scrollTrace));
  const previewFollowerLagFrames = scrollTrace.frames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = scrollTrace.frames[index - 1];
    return Math.abs(frame.scrollTop - previous.scrollTop) > 5
      && Math.abs(frame.editorScrollTop - previous.editorScrollTop) <= 1;
  });
  assert.equal(
    previewFollowerLagFrames.length,
    0,
    `Preview-driven linked scrolling must update Source in the same sampled frame: ${JSON.stringify(scrollTrace.frames)}`
  );

  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => (
    document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live'
    && document.querySelector<HTMLElement>('.preview-host')?.hidden === true
  ));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const samples: Array<{ hidden: boolean; scrollTop: number }> = [];
    const startedAt = performance.now();
    let visibleFrames = 0;
    const sample = () => {
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument;
      const hidden = host.hidden || getComputedStyle(host).visibility === 'hidden';
      samples.push({ hidden, scrollTop: frameDocument?.scrollingElement?.scrollTop ?? 0 });
      if (!hidden) visibleFrames += 1;
      // Cover the first visible frames even when asynchronous rendering finishes later.
      if (visibleFrames < 8 && performance.now() - startedAt < 3000) requestAnimationFrame(sample);
    };
    (window as typeof window & { __sourceSplitEntrySamples?: typeof samples }).__sourceSplitEntrySamples = samples;
    requestAnimationFrame(sample);
  });
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await page.waitForFunction(() => (
    (window as typeof window & {
      __sourceSplitEntrySamples: Array<{ hidden: boolean; scrollTop: number }>;
    }).__sourceSplitEntrySamples.filter(sample => !sample.hidden).length >= 8
  ), { timeout: 3500 });
  const splitEntrySamples = await page.evaluate(() => (
    (window as typeof window & {
      __sourceSplitEntrySamples: Array<{ hidden: boolean; scrollTop: number }>;
    }).__sourceSplitEntrySamples
  ));
  const visibleSplitEntryPositions = splitEntrySamples
    .filter(sample => !sample.hidden)
    .map(sample => sample.scrollTop);
  assert.ok(visibleSplitEntryPositions.length >= 2, JSON.stringify(splitEntrySamples));
  assert.ok(
    Math.max(...visibleSplitEntryPositions) - Math.min(...visibleSplitEntryPositions) <= 1,
    `A split Preview must be at its final position before its first visible frame: ${JSON.stringify(splitEntrySamples)}`
  );

  const modeAnchorText = 'Section 80';
  const modeAnchorLine = text.slice(0, text.indexOf(`## ${modeAnchorText}`)).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(modeAnchorLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(anchorText => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
    .some(line => line.textContent?.includes(anchorText)), {}, modeAnchorText);
  await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
  }, modeAnchorText);
  await new Promise(resolve => setTimeout(resolve, 120));
  const readModeAnchorOffset = async (surface: 'editor' | 'preview') => page.evaluate(({ surface, anchorText }) => {
    if (surface === 'preview') {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const heading = Array.from(frame.contentDocument!.querySelectorAll<HTMLElement>('h2'))
        .find(candidate => candidate.textContent?.includes(anchorText))!;
      return heading.getBoundingClientRect().top;
    }
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, { surface, anchorText: modeAnchorText });
  const modeAnchorOffsets: Array<{ mode: string; offset: number }> = [
    { mode: 'source', offset: await readModeAnchorOffset('editor') }
  ];
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'live', offset: await readModeAnchorOffset('editor') });
  await page.evaluate(anchorText => {
    const samples: number[] = [];
    let remaining = 16;
    const sample = () => {
      const root = document.querySelector<HTMLElement>('#app');
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      const heading = Array.from(frame?.contentDocument?.querySelectorAll<HTMLElement>('h2') ?? [])
        .find(candidate => candidate.textContent?.includes(anchorText));
      if (root?.dataset.mode === 'preview' && heading) samples.push(heading.getBoundingClientRect().top);
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    (window as typeof window & { __fullPreviewEntryAnchorSamples?: number[] })
      .__fullPreviewEntryAnchorSamples = samples;
    requestAnimationFrame(sample);
  }, modeAnchorText);
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'preview', offset: await readModeAnchorOffset('preview') });
  const fullPreviewEntryAnchorSamples = await page.evaluate(() => (
    (window as typeof window & { __fullPreviewEntryAnchorSamples?: number[] })
      .__fullPreviewEntryAnchorSamples ?? []
  ));
  assert.ok(fullPreviewEntryAnchorSamples.length >= 2, JSON.stringify(fullPreviewEntryAnchorSamples));
  assert.ok(
    Math.max(...fullPreviewEntryAnchorSamples) - Math.min(...fullPreviewEntryAnchorSamples) <= 2,
    `Full Preview must enter at its final reading position: ${JSON.stringify(fullPreviewEntryAnchorSamples)}`
  );
  const fullPreviewTableFit = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Array.from(frameDocument.querySelectorAll<HTMLTableElement>('table')).map(table => {
      const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block')!;
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        overflow: wrapper.scrollWidth - wrapper.clientWidth,
        overflowX: getComputedStyle(wrapper).overflowX,
        rightOverflow: tableRect.right - wrapperRect.right,
        rightSafetyInset: wrapperRect.right - tableRect.right
      };
    });
  });
  assert.ok(fullPreviewTableFit.every(table => table.overflow <= 0.5), JSON.stringify(fullPreviewTableFit));
  assert.ok(
    fullPreviewTableFit.every(table => table.overflowX === 'clip' || table.overflowX === 'hidden'),
    JSON.stringify(fullPreviewTableFit)
  );
  assert.ok(fullPreviewTableFit.every(table => table.rightOverflow <= 0.5), JSON.stringify(fullPreviewTableFit));
  assert.ok(fullPreviewTableFit.every(table => table.rightSafetyInset >= 0.75), JSON.stringify(fullPreviewTableFit));
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'source-return', offset: await readModeAnchorOffset('editor') });
  const baselineModeAnchorOffset = modeAnchorOffsets[0].offset;
  assert.ok(
    modeAnchorOffsets.every(sample => Math.abs(sample.offset - baselineModeAnchorOffset) <= 20),
    `Mode switches must keep one semantic reading anchor on the same screen band: ${JSON.stringify(modeAnchorOffsets)}`
  );

  const complexTableStartLine = text.slice(0, text.indexOf('| Mode row | Content |')).split('\n').length;
  const complexTableAnchorText = 'Mode row 8';
  const complexTableAnchorLine = complexTableStartLine + 9;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(complexTableAnchorLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(anchorText => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
    .some(line => line.textContent?.includes(anchorText)), {}, complexTableAnchorText);
  await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
  }, complexTableAnchorText);
  const complexTableSourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(complexTableSourceBounds.x, complexTableSourceBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const complexTableSourceOffset = await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, complexTableAnchorText);
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 160));
  const complexTableLiveProjection = await page.evaluate(targetLine => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    // Rich rows have their own source geometry. A whole-table height ratio
    // includes header/row spacing and can misreport a correctly retained row.
    const row = scroller.querySelector<HTMLElement>(
      `.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number="${targetLine}"]`
    );
    if (!row) return Number.NaN;
    const viewport = scroller.getBoundingClientRect();
    return row.getBoundingClientRect().top - viewport.top;
  }, complexTableAnchorLine);
  assert.ok(
    Math.abs(complexTableLiveProjection - complexTableSourceOffset) <= 20,
    JSON.stringify({ complexTableSourceOffset, complexTableLiveProjection })
  );
  const complexLiveSemanticAnchor = await page.evaluate(startLine => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const readingY = viewport.top + viewport.height / 3;
    const block = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
    )).find(candidate => Number(candidate.dataset.meoRenderedBlockStartLine) === startLine);
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return {
      startLine: Number(block.dataset.meoRenderedBlockStartLine),
      endLine: Number(block.dataset.meoRenderedBlockEndLine),
      progress: Math.max(0, Math.min(1, (readingY - rect.top) / Math.max(1, rect.height)))
    };
  }, complexTableStartLine);
  assert.ok(complexLiveSemanticAnchor, 'The table fixture must expose a rendered semantic range');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await new Promise(resolve => setTimeout(resolve, 160));
  const complexPreviewSemanticOffset = await page.evaluate(anchor => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const readingBand = frameDocument.documentElement.clientHeight / 3;
    const entry = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .filter(element => (
        Number(element.dataset.sourceLine) === anchor.startLine
        && Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine) === anchor.endLine
      ))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => Math.abs(left.rect.top - readingBand) - Math.abs(right.rect.top - readingBand))[0];
    return entry
      ? entry.rect.top + entry.rect.height * anchor.progress - readingBand
      : null;
  }, complexLiveSemanticAnchor!);
  assert.ok(
    complexPreviewSemanticOffset !== null && Math.abs(complexPreviewSemanticOffset) <= 2,
    `Live-to-Preview must preserve continuous table progress: ${JSON.stringify({ complexLiveSemanticAnchor, complexPreviewSemanticOffset })}`
  );
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 160));
  const readComplexTableSourceOffset = () => page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, complexTableAnchorText);
  const complexTableSourceReturnOffsets = [await readComplexTableSourceOffset()];
  for (let round = 0; round < 3; round += 1) {
    await page.click('button[data-mode="live"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
    await page.evaluate(() => new Promise<void>(resolve => {
      let remainingFrames = 10;
      const waitForFrame = () => {
        remainingFrames -= 1;
        if (remainingFrames <= 0) resolve();
        else requestAnimationFrame(waitForFrame);
      };
      requestAnimationFrame(waitForFrame);
    }));
    complexTableSourceReturnOffsets.push(await readComplexTableSourceOffset());
  }
  assert.ok(
    complexTableSourceReturnOffsets.every(offset => Math.abs(offset - complexTableSourceOffset) <= 20),
    JSON.stringify({
      complexTableSourceOffset,
      complexTableSourceReturnOffsets,
      complexLiveSemanticAnchor,
    })
  );

  const splitSourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(splitSourceBounds.x, splitSourceBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const splitModeRoundTripScrollTops = [await page.$eval(
    '.cm-scroller',
    element => (element as HTMLElement).scrollTop
  )];
  for (let round = 0; round < 8; round += 1) {
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await new Promise(resolve => setTimeout(resolve, 80));
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
      && document.querySelector<HTMLElement>('.editor-surface')?.hasAttribute('data-source-preview')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden'
    ));
    await new Promise(resolve => setTimeout(resolve, 120));
    splitModeRoundTripScrollTops.push(await page.$eval(
      '.cm-scroller',
      element => (element as HTMLElement).scrollTop
    ));
  }
  const splitModeRoundTripBaseline = splitModeRoundTripScrollTops[0]!;
  const splitModeRoundTripDrift = splitModeRoundTripScrollTops.map(
    scrollTop => scrollTop - splitModeRoundTripBaseline
  );
  assert.ok(
    splitModeRoundTripDrift.every(drift => Math.abs(drift) <= 2),
    `Repeated Source split ↔ Preview round-trips must not accumulate viewport drift: ${JSON.stringify(splitModeRoundTripDrift)}`
  );

  const splitPreviewRoundTripBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(splitPreviewRoundTripBounds.x, splitPreviewRoundTripBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const previewOwnedRoundTripScrollTops = [await page.$eval(
    '.preview-frame',
    frame => (frame as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop
  )];
  for (let round = 0; round < 8; round += 1) {
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await new Promise(resolve => setTimeout(resolve, 80));
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
      && document.querySelector<HTMLElement>('.editor-surface')?.hasAttribute('data-source-preview')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden'
    ));
    await new Promise(resolve => setTimeout(resolve, 120));
    previewOwnedRoundTripScrollTops.push(await page.$eval(
      '.preview-frame',
      frame => (frame as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop
    ));
  }
  const previewOwnedRoundTripBaseline = previewOwnedRoundTripScrollTops[0]!;
  const previewOwnedRoundTripDrift = previewOwnedRoundTripScrollTops.map(
    scrollTop => scrollTop - previewOwnedRoundTripBaseline
  );
  assert.ok(
    previewOwnedRoundTripDrift.every(drift => Math.abs(drift) <= 2),
    `Preview-owned Source split ↔ Preview round-trips must not accumulate viewport drift: ${JSON.stringify(previewOwnedRoundTripDrift)}`
  );

  await alignSourceLineAtReadingBand(transitionTableAnchorLine);
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 120));
  const tableHeaderColors = await page.evaluate(() => {
    const liveTable = Array.from(document.querySelectorAll<HTMLTableElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
    )).find(table => table.textContent?.includes('asd332'));
    const previewDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const previewTable = Array.from(previewDocument.querySelectorAll<HTMLTableElement>('table'))
      .find(table => table.textContent?.includes('asd332'));
    const liveHeader = liveTable?.querySelector<HTMLElement>('thead th') ?? null;
    const previewHeader = previewTable?.querySelector<HTMLElement>('thead th') ?? null;
    const selectionMenu = document.querySelector<HTMLElement>('.selection-inline-menu');
    const tableMenu = liveTable?.closest('.meo-md-html-table-shell')
      ?.querySelector<HTMLElement>('.meo-md-html-table-context-menu') ?? null;
    const menuBackgrounds = () => ({
      selection: selectionMenu ? getComputedStyle(selectionMenu).backgroundColor : null,
      table: tableMenu ? getComputedStyle(tableMenu).backgroundColor : null
    });
    const darkMenus = menuBackgrounds();
    return {
      live: liveHeader ? getComputedStyle(liveHeader).backgroundColor : null,
      preview: previewHeader ? previewDocument.defaultView!.getComputedStyle(previewHeader).backgroundColor : null,
      darkMenus
    };
  });
  assert.ok(tableHeaderColors.live && tableHeaderColors.preview, JSON.stringify(tableHeaderColors));
  assert.equal(tableHeaderColors.live, tableHeaderColors.preview, 'Default Preview shares the editor document palette');
  assert.equal(tableHeaderColors.darkMenus.selection, tableHeaderColors.darkMenus.table, JSON.stringify(tableHeaderColors));
  await page.$eval('.editor-appearance-button[data-editor-appearance="light"]', button => (button as HTMLButtonElement).click());
  await page.waitForFunction(() => document.documentElement.dataset.editorAppearance === 'light');
  const lightMenus = await page.evaluate(() => ({
    selection: getComputedStyle(document.querySelector('.selection-inline-menu')!).backgroundColor,
    table: getComputedStyle(document.querySelector('.meo-md-html-table-context-menu')!).backgroundColor
  }));
  assert.equal(lightMenus.selection, lightMenus.table, JSON.stringify(lightMenus));
  assert.notEqual(lightMenus.selection, tableHeaderColors.darkMenus.selection, 'Appearance controls must actually change the menu palette');
  await page.$eval('.editor-appearance-button[data-editor-appearance="dark"]', button => (button as HTMLButtonElement).click());
  await page.waitForFunction(() => document.documentElement.dataset.editorAppearance === 'dark');
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  // Keep sampling until the asynchronous mode transaction has exposed its final surface.
  await waitForPreviewTransition('source');
  await new Promise(resolve => setTimeout(resolve, 220));
  const splitModeEntryFrames = await stopPreviewAnchorSampling();
  const visibleSplitModeOffsets = splitModeEntryFrames
    .filter(frame => frame.visible && frame.offset !== null)
    .map(frame => frame.offset as number);
  assert.ok(visibleSplitModeOffsets.length >= 2, JSON.stringify(splitModeEntryFrames));
  assert.ok(
    Math.max(...visibleSplitModeOffsets) - Math.min(...visibleSplitModeOffsets) <= 1,
    `Split Preview content must not reflow after its first visible frame: ${JSON.stringify(splitModeEntryFrames)}`
  );

  await alignSourceLineAtReadingBand(transitionTableAnchorLine);
  const splitPreviewBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  const beforePreviewOwnership = (await stopPreviewAnchorSampling()).at(-1)?.offset;
  assert.ok(typeof beforePreviewOwnership === 'number', 'the complex Preview anchor must be measurable before its gesture');
  await page.mouse.move(splitPreviewBounds.x, splitPreviewBounds.y);
  // This transition is owned by Preview. Align its actual rendered range;
  // aligning Source first does not put a differently sized table at that band.
  await page.mouse.wheel({ deltaY: Math.abs(beforePreviewOwnership) > 0.5 ? beforePreviewOwnership : 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  const alignedPreviewOwnership = (await stopPreviewAnchorSampling()).at(-1)?.offset;
  assert.ok(typeof alignedPreviewOwnership === 'number' && Math.abs(alignedPreviewOwnership) <= 2,
    `Preview must actually own the complex anchor at its reading band before switching: ${alignedPreviewOwnership}`);
  const sourceToFullReadingAnchor = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const viewportTop = frameDocument.scrollingElement?.scrollTop ?? 0;
    const viewportAnchor = viewportTop + frameDocument.documentElement.clientHeight / 3;
    const entries = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          startLine: Number(element.dataset.sourceLine),
          endLine: Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine),
          top: rect.top + viewportTop,
          bottom: rect.bottom + viewportTop,
          height: rect.height
        };
      })
      .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.startLine - right.startLine);
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].top <= viewportAnchor + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    const candidate = entries[Math.max(0, high)];
    return candidate ? {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      progress: Math.max(0, Math.min(1, (viewportAnchor - candidate.top) / Math.max(1, candidate.height)))
    } : null;
  });
  assert.ok(sourceToFullReadingAnchor, 'Split Preview must expose a semantic reading anchor');
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  await page.evaluate(() => {
    (window as typeof window & {
      __previewModeAnchorProbe: { markStarted(): void };
    }).__previewModeAnchorProbe.markStarted();
    document.querySelector<HTMLButtonElement>('button[data-mode="preview"]')!.click();
  });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  // Keep sampling until the asynchronous mode transaction has exposed its final surface.
  await waitForPreviewTransition('preview');
  await new Promise(resolve => setTimeout(resolve, 220));
  const sourceToFullPreviewFrames = await stopPreviewAnchorSampling();
  const lastSplitFrame = sourceToFullPreviewFrames
    .filter(frame => !frame.started && frame.split && frame.editorVisible && frame.editorOffset !== null)
    .at(-1);
  const coveredSourceFrames = sourceToFullPreviewFrames.filter(frame => (
    frame.started && frame.covered && frame.editorVisible && frame.editorOffset !== null
  ));
  assert.ok(lastSplitFrame && coveredSourceFrames.length > 0, JSON.stringify(sourceToFullPreviewFrames));
  assert.ok(
    coveredSourceFrames.every(frame => (
      Math.abs(frame.editorWidth - lastSplitFrame.editorWidth) <= 1
      && Math.abs((frame.editorOffset as number) - (lastSplitFrame.editorOffset as number)) <= 1
    )),
    `Source-to-Preview must not reflow the visible Source cover before Preview paints: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  const visibleSourceToFullPreviewFrames = sourceToFullPreviewFrames
    .filter(frame => frame.mode === 'preview' && frame.visible && frame.offset !== null);
  const finalFullPreviewFrame = visibleSourceToFullPreviewFrames.at(-1);
  assert.ok(finalFullPreviewFrame, JSON.stringify(sourceToFullPreviewFrames));
  assert.ok(
    sourceToFullPreviewFrames.some(frame => frame.started && frame.covered),
    `Source-to-Preview must cover the resized iframe until its compositor is ready: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  const uncoveredTransitionFrames = sourceToFullPreviewFrames
    .filter(frame => frame.started && frame.visible && !frame.covered && frame.offset !== null);
  assert.ok(
    uncoveredTransitionFrames.every(frame => (
      Math.abs(frame.width - finalFullPreviewFrame.width) <= 1
      && Math.abs((frame.offset as number) - (finalFullPreviewFrame.offset as number)) <= 1
    )),
    `Source-to-Preview must keep the previous surface covering intermediate geometry: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  const visibleSourceToFullPreviewOffsets = visibleSourceToFullPreviewFrames
    .map(frame => frame.offset as number);
  assert.ok(
    Math.max(...visibleSourceToFullPreviewOffsets) - Math.min(...visibleSourceToFullPreviewOffsets) <= 1,
    `Source-to-Preview must not move after its first visible frame: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  assert.ok(
    lastSplitFrame.offset !== null
      && Math.abs((finalFullPreviewFrame.offset as number) - lastSplitFrame.offset) <= 20,
    `Source-to-Preview must retain the existing complex reading position after full-width layout: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  const finalReadingAnchorOffset = await page.evaluate(anchor => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const readingBand = frameDocument.documentElement.clientHeight / 3;
    const entry = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .filter(element => (
        Number(element.dataset.sourceLine) === anchor.startLine
        && Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine) === anchor.endLine
      ))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => Math.abs(left.rect.top - readingBand) - Math.abs(right.rect.top - readingBand))[0];
    return entry
      ? entry.rect.top + entry.rect.height * anchor.progress - readingBand
      : null;
  }, sourceToFullReadingAnchor!);
  assert.ok(
    finalReadingAnchorOffset !== null && Math.abs(finalReadingAnchorOffset) <= 1,
    `Source-to-Preview must preserve the already-visible Preview reading anchor: ${JSON.stringify({ sourceToFullReadingAnchor, finalReadingAnchorOffset, sourceToFullPreviewFrames })}`
  );
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  await page.evaluate(() => {
    (window as typeof window & {
      __previewModeAnchorProbe: { markStarted(): void };
    }).__previewModeAnchorProbe.markStarted();
    document.querySelector<HTMLButtonElement>('button[data-mode="source"]')!.click();
  });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  // Keep sampling until the asynchronous mode transaction has exposed its final surface.
  await waitForPreviewTransition('source');
  await new Promise(resolve => setTimeout(resolve, 220));
  const fullPreviewToSourceFrames = await stopPreviewAnchorSampling();
  const visibleReverseFrames = fullPreviewToSourceFrames.filter(frame => (
    frame.started
    && frame.mode === 'source'
    && frame.split
    && frame.visible
    && frame.editorVisible
    && frame.offset !== null
    && frame.editorOffset !== null
  ));
  const finalReverseFrame = visibleReverseFrames.at(-1);
  assert.ok(finalReverseFrame, JSON.stringify(fullPreviewToSourceFrames));
  assert.ok(
    visibleReverseFrames.every(frame => (
      Math.abs(frame.width - finalReverseFrame.width) <= 1
      && Math.abs(frame.editorWidth - finalReverseFrame.editorWidth) <= 1
      && Math.abs((frame.offset as number) - (finalReverseFrame.offset as number)) <= 1
      && Math.abs((frame.editorOffset as number) - (finalReverseFrame.editorOffset as number)) <= 1
    )),
    `Preview-to-Source must not expose intermediate split geometry or anchor movement: ${JSON.stringify(fullPreviewToSourceFrames)}`
  );

  const waitForMode = async (mode: 'live' | 'source' | 'preview') => {
    await page.waitForFunction(expectedMode => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === expectedMode
      && (expectedMode !== 'live' || document.querySelector<HTMLElement>('.preview-host')?.hidden === true)
    ), {}, mode);
    await new Promise(resolve => setTimeout(resolve, 120));
  };
  const selectMode = async (mode: 'live' | 'source' | 'preview') => {
    await page.click(`button[data-mode="${mode}"]`);
    await waitForMode(mode);
  };
  const setSourcePreviewEnabled = async (enabled: boolean) => {
    if (await page.$eval('#app', element => (element as HTMLElement).dataset.mode) !== 'source') {
      await selectMode('source');
    }
    const current = await page.$eval(
      '.editor-surface',
      element => element.hasAttribute('data-source-preview')
    );
    if (current === enabled) return;
    await page.click('.source-preview-button');
    await page.waitForFunction(expected => (
      document.querySelector('.editor-surface')?.hasAttribute('data-source-preview') === expected
    ), {}, enabled);
    await new Promise(resolve => setTimeout(resolve, 120));
  };
  const assertLiveRevealStable = async (label: string) => {
    await startEditorAnchorSampling(modeAnchorText);
    await page.evaluate(() => {
      (window as typeof window & {
        __editorModeAnchorProbe: { markStarted(): void };
      }).__editorModeAnchorProbe.markStarted();
      document.querySelector<HTMLButtonElement>('button[data-mode="live"]')!.click();
    });
    await waitForMode('live');
    const frames = await stopEditorAnchorSampling();
    const visibleLiveFrames = frames.filter(frame => (
      frame.started
      && frame.mode === 'live'
      && !frame.previewVisible
      && frame.editorVisible
      && frame.offset !== null
    ));
    const finalLiveFrame = visibleLiveFrames.at(-1);
    assert.ok(finalLiveFrame && visibleLiveFrames.length >= 2, `${label}: ${JSON.stringify(frames)}`);
    assert.ok(
      visibleLiveFrames.every(frame => (
        Math.abs(frame.width - finalLiveFrame.width) <= 1
        && Math.abs((frame.offset as number) - (finalLiveFrame.offset as number)) <= 1
      )),
      `${label} must reveal Live at its final reading position: ${JSON.stringify(frames)}`
    );
  };
  const exerciseModeCycles = async (splitEnabled: boolean) => {
    const prefix = splitEnabled ? 'Split enabled' : 'Split disabled';
    await setSourcePreviewEnabled(splitEnabled);
    await selectMode('live');

    await selectMode('source');
    await alignSourceLineAtReadingBand(modeAnchorLine);
    await selectMode('preview');
    await assertLiveRevealStable(`${prefix} Live-to-Source-to-Preview-to-Live`);

    await selectMode('preview');
    await selectMode('source');
    await assertLiveRevealStable(`${prefix} Live-to-Preview-to-Source-to-Live`);
  };

  await exerciseModeCycles(true);
  await exerciseModeCycles(false);
  await setSourcePreviewEnabled(true);

  await page.evaluate(() => {
    const sourceScroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    sourceScroller.scrollTop = 600;
    sourceScroller.dispatchEvent(new Event('scroll'));
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  const scrollTopButtonVisual = await page.$eval('.preview-host > .document-scroll-top', element => {
    const button = element.getBoundingClientRect();
    const icon = element.querySelector<SVGElement>('svg')!.getBoundingClientRect();
    return {
      iconWidth: icon.width,
      iconHeight: icon.height,
      centerOffsetX: (icon.left + icon.width / 2) - (button.left + button.width / 2),
      centerOffsetY: (icon.top + icon.height / 2) - (button.top + button.height / 2)
    };
  });
  assert.deepEqual(
    { width: scrollTopButtonVisual.iconWidth, height: scrollTopButtonVisual.iconHeight },
    { width: 18, height: 18 },
    JSON.stringify(scrollTopButtonVisual)
  );
  assert.ok(Math.abs(scrollTopButtonVisual.centerOffsetX) <= 0.25, JSON.stringify(scrollTopButtonVisual));
  assert.ok(Math.abs(scrollTopButtonVisual.centerOffsetY - 1) <= 0.25, JSON.stringify(scrollTopButtonVisual));
  await page.click('.preview-host > .document-scroll-top');
  await new Promise(resolve => setTimeout(resolve, 120));
  const previewButtonTop = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    previewButtonTop.source <= 0.5 && previewButtonTop.preview <= 0.5,
    `Preview back-to-top must move both linked surfaces: ${JSON.stringify(previewButtonTop)}`
  );

  const previewFrameBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(previewFrameBounds.x, previewFrameBounds.y);
  await page.mouse.wheel({ deltaY: 600 });
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.click('.editor-host > .document-scroll-top');
  await new Promise(resolve => setTimeout(resolve, 120));
  const sourceButtonTop = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    sourceButtonTop.source <= 0.5 && sourceButtonTop.preview <= 0.5,
    `Source back-to-top must move both linked surfaces: ${JSON.stringify(sourceButtonTop)}`
  );

  await page.click('.source-preview-scroll-sync-button');
  const independentState = await page.$eval('.source-preview-scroll-sync-button', button => ({
    pressed: button.getAttribute('aria-pressed'),
    independent: button.classList.contains('is-independent'),
    icon: button.querySelector('svg')?.getAttribute('data-icon')
  }));
  assert.equal(independentState.pressed, 'false');
  assert.equal(independentState.independent, true);
  assert.equal(independentState.icon, 'unlink');
  const independentStart = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  const syncButtonBounds = await page.$eval('.source-preview-scroll-sync-button', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(syncButtonBounds.x, syncButtonBounds.y);
  await page.mouse.wheel({ deltaY: 600 });
  await new Promise(resolve => setTimeout(resolve, 120));
  const independentWheel = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    independentWheel.preview > independentStart.preview + 100,
    `Wheel over the floating sync control must keep scrolling Preview: ${JSON.stringify({ independentStart, independentWheel })}`
  );
  assert.ok(
    Math.abs(independentWheel.source - independentStart.source) <= 0.5,
    `Independent Preview scrolling must not move Source: ${JSON.stringify({ independentStart, independentWheel })}`
  );
  await page.click('.source-preview-scroll-sync-button');
  await new Promise(resolve => setTimeout(resolve, 120));
  const relinkedState = await page.evaluate(() => ({
    pressed: document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed'),
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.equal(relinkedState.pressed, 'true');
  assert.ok(
    relinkedState.source > independentStart.source + 100,
    `Re-enabling sync must align once from the last active Preview pane: ${JSON.stringify({ independentStart, independentWheel, relinkedState })}`
  );

  const reloadAnchorLine = text.slice(0, text.indexOf('## Section 100')).split('\n').length;
  const readSplitPreviewPosition = () => page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const scroller = frameDocument.scrollingElement!;
    const entries = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => {
        const start = Number(element.dataset.sourceLine);
        const end = Number(element.dataset.sourceEndLine ?? start);
        const rect = element.getBoundingClientRect();
        return { start, end, top: rect.top + scroller.scrollTop, bottom: rect.bottom + scroller.scrollTop };
      })
      .filter(entry => Number.isFinite(entry.start))
      .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.start - right.start);
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].top <= scroller.scrollTop + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    const visible = entries[Math.max(0, high)];
    const ratio = visible.bottom > visible.top
      ? Math.max(0, Math.min(1, (scroller.scrollTop - visible.top) / (visible.bottom - visible.top)))
      : 0;
    return {
      scrollTop: scroller.scrollTop,
      line: Math.round(visible.start + (visible.end - visible.start) * ratio),
      offset: visible.top - scroller.scrollTop,
      range: { start: visible.start, end: visible.end },
      geometry: { top: visible.top, bottom: visible.bottom }
    };
  });
  for (const [index, lineEnding] of ['\n', '\r\n'].entries()) {
    console.log(`Checking split disk reload with ${lineEnding === '\n' ? 'LF' : 'CRLF'}`);
    const diskMarker = `Disk reload ${index + 1}`;
    await page.evaluate(({ text, lineEnding, diskMarker }) => {
      (window as any).__sourceSideDiskText = text.replace('Intro paragraph', diskMarker).replace(/\n/g, lineEnding);
    }, { text, lineEnding, diskMarker });
    await page.evaluate(line => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const target = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .find(element => Number(element.dataset.sourceLine) === line)!;
      frameDocument.scrollingElement!.scrollTop += target.getBoundingClientRect().top - 40;
      frameDocument.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, reloadAnchorLine);
    await new Promise(resolve => setTimeout(resolve, 120));
    const reloadBefore = await readSplitPreviewPosition();
    assert.ok(reloadBefore.scrollTop > 100, JSON.stringify(reloadBefore));
    await page.$eval<HTMLButtonElement>('[data-action="discard"]', button => {
      button.click();
      button.click();
    });
    await page.waitForFunction(reloadId => (window as any).__sourceSideMessages.some(
      (message: any) => message.type === 'documentReloadPresentationCompleted' && message.reloadId === reloadId
    ), {}, index + 1).catch(async error => {
      throw new Error(`Disk reload did not complete: ${JSON.stringify(await page.evaluate(() => (window as any).__sourceSideMessages.slice(-5)))}`, { cause: error });
    });
    assert.equal(await page.evaluate(reloadId => (window as any).__sourceSideMessages.find(
      (message: any) => message.type === 'documentReloadPresentationCompleted' && message.reloadId === reloadId
    )?.presented, index + 1), true, 'Disk reload must present the new Revision');
    await page.waitForFunction(marker => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('main.meo-export-doc')?.textContent?.includes(marker), {}, diskMarker).catch(async error => {
      throw new Error(`Disk reload did not render ${diskMarker}: ${JSON.stringify(await page.evaluate(() => ({
        status: document.querySelector('.preview-status')?.textContent,
        body: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc')?.textContent?.slice(0, 160)
      })))}`, { cause: error });
    });
    await new Promise(resolve => setTimeout(resolve, 160));
    const reloadAfter = await readSplitPreviewPosition();
    assert.equal(reloadAfter.line, reloadBefore.line, JSON.stringify({ reloadBefore, reloadAfter }));
    assert.ok(
      Math.abs(reloadAfter.offset - reloadBefore.offset) <= 6,
      JSON.stringify({ reloadBefore, reloadAfter })
    );
  }

  await page.click('.source-preview-button');
  const closed = await page.evaluate(() => ({
    split: document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'),
    previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
    editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
    label: document.querySelector<HTMLButtonElement>('.source-preview-button')?.textContent?.trim(),
    syncVisible: document.querySelector<HTMLElement>('.source-preview-scroll-sync-button')?.offsetParent !== null
  }));
  assert.deepEqual(closed, {
    split: false,
    previewHidden: true,
    editorHidden: false,
    label: '',
    syncVisible: false
  });
  await page.click('.source-preview-button');
  await page.waitForFunction(() => (
    document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
    && document.querySelector<HTMLElement>('.preview-host')?.inert === false
    && document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed') === 'true'
  ));
  await page.click('.source-preview-scroll-sync-button');
  assert.equal(
    await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')),
    'false'
  );
  assert.equal(
    await page.evaluate(() => Object.hasOwn((window as any).__sourceSideUiState, 'sourcePreviewScrollSyncEnabled')),
    false,
    'Temporary scroll-sync changes must not enter persisted Webview state'
  );
  await page.click('.source-preview-button');
  await page.click('.source-preview-button');
  await page.waitForFunction(() => (
    document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
    && document.querySelector<HTMLElement>('.preview-host')?.inert === false
  ));
  assert.equal(
    await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')),
    'false',
    'Reopening side Preview in the same document session must retain the user choice'
  );
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await page.click('.preview-options-trigger');
  assert.equal(await page.$eval('.preview-options-panel .preview-font-family-control', element => element.offsetParent !== null), true);
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => (
    document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
    && document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
    && document.querySelector<HTMLElement>('.preview-host')?.inert === false
  ));
  assert.equal(await page.$eval('.source-preview-more-panel .preview-font-family-control', element => element.isConnected), true);
  assert.equal(
    await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')),
    'false',
    'Mode switching in the same document session must retain the user choice'
  );
  await page.click('.source-preview-button');
  const closedRenderCount = previewRenderCount;
  await page.keyboard.type('OFF');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(previewRenderCount, closedRenderCount, 'Closed side Preview must add no typing work');
  assert.ok(preloadCount >= 1, 'The fixture should exercise the existing hidden preload path');
  await page.click('.source-preview-button');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-host')?.inert === false);
  await page.click('.source-preview-more-button');
  await page.click('.source-preview-more-panel [data-preview-comments="true"]');
  assert.equal(await page.$eval('.source-preview-more-button', button => button.getAttribute('aria-expanded')), 'true');
  assert.equal(await page.$eval('.source-preview-more-panel [data-preview-comments="true"]', button => button.getAttribute('aria-pressed')), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.source-preview-more-panel', panel => (panel as HTMLElement).hidden), true);
  await page.setViewport({ width: 420, height: 760 });
  await page.click('.source-preview-more-button');
  const narrowMenuBounds = await page.$eval('.source-preview-more-panel', panel => {
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
  });
  assert.ok(narrowMenuBounds.left >= 8 && narrowMenuBounds.right <= narrowMenuBounds.viewportWidth - 8, JSON.stringify(narrowMenuBounds));
  await page.click('.cm-content');
  await page.click('.source-preview-more-button');
  await page.click('.source-preview-more-panel .preview-font-family-dropdown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'combobox');
  await page.click('.preview-font-family-dropdown-panel [role="option"]:nth-child(2)');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.preview-font-family-dropdown-panel input'));
  assert.equal(await page.$eval('.preview-font-family-dropdown-panel', panel => (panel as HTMLElement).hidden), false, 'Choosing a font keeps comparison open');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.source-preview-more-panel', panel => (panel as HTMLElement).hidden), false, 'First Escape closes the font child only');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.source-preview-more-panel', panel => (panel as HTMLElement).hidden), true);
  await page.waitForFunction(() => document.activeElement === document.querySelector('.source-preview-more-button'));
  }
  await assertScrollContinuityAndAlignment(await browser.newPage(), await build.outputs[0]!.text(), false);
  await assertScrollContinuityAndAlignment(await browser.newPage(), await build.outputs[0]!.text(), true);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source side Preview checks passed');
