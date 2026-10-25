import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { createPreviewPresetLibrary, type StoredPreviewPreset } from '../src/host/customPreviewPresets';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';

const large = process.argv.includes('--large');
const katexCss = `data:text/css;base64,${Buffer.from(await Bun.file('node_modules/katex/dist/katex.min.css').text()).toString('base64')}`;
// Formula fitting runs after the preset commit. Its late height change must
// belong to the same viewport owner as the synchronous style/DOM update.
const markdown = (large ? '[Read section 95](#section-95)\n\n' : '') + Array.from({ length: large ? 180 : 8 }, (_, section) =>
  `## Section ${section + 1}\n\n` +
  '$$\n\\bar{x} = \\frac{1}{n}\\sum_{k=1}^{n}x_k\n$$\n\n' +
  Array.from({ length: 4 }, (_, paragraph) =>
    `**Paragraph ${section + 1}-${paragraph + 1}:** ` + `Reading position ${section + 1}-${paragraph + 1} should follow the same document content. `.repeat(large ? 20 : 12)
  ).join('\n\n') + `\n\n\`inline_probe_${section + 1}()\` is inline code with **emphasis**.\n\n` +
  '| Column | Description |\n| --- | --- |\n| Cell | Wrapped table contents for preset comparison |\n\n- List item\n- [ ] Task item\n\n```ts\nconst value = { count: 1 };\n```\n'
).join('\n\n');
const store = new Map<string, StoredPreviewPreset>();
const library = createPreviewPresetLibrary({
  list: async () => [...store.keys()], read: async id => store.get(id)!,
  write: async (id, value) => { store.set(id, value); }, remove: async id => { store.delete(id); }
});
const custom = await library.import(JSON.stringify({
  schemaVersion: 1, id: 'narrow-reading', name: 'Narrow reading', description: 'Different type and width',
  themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } }
}), async () => '.meo-export-doc { max-width: 620px; padding: 48px; font-family: Georgia, serif; font-size: 20px; line-height: 1.85; }');
const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const settle = (milliseconds = 150) => new Promise(resolve => setTimeout(resolve, milliseconds));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const appearance of ['light', 'dark']) for (const surface of ['preview', 'linked-source', 'independent-source']) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1200, height: 800 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ url: katexCss });
    await page.evaluate(href => { document.body.dataset.meoKatexSrc = href; }, katexCss);
    let nextResponseGate: { promise: Promise<void>; requested: boolean; release: () => void } | undefined;
    const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
    const holdNextResponse = () => {
      let release = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      const gate = { promise, requested: false, release: () => release() };
      nextResponseGate = gate;
      return gate;
    };
    await page.exposeFunction('__renderPresetPosition', async (message: any) => {
      if (message.type === 'requestPreviewDocument') return {
        type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
        result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) }
      };
      if (message.type !== 'requestPreviewRender') return null;
      const gate = nextResponseGate;
      nextResponseGate = undefined;
      if (gate) { gate.requested = true; await gate.promise; }
      const options = {
        markdownText: message.text, sourceDocumentPath: 'C:/tmp/preset-position.md', uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment, preset: message.preset,
        presetDefinition: message.preset === custom.id ? library.get(custom.id) : undefined
      };
      const parsed = message.window ? createPreviewDocument(message.requestId, options) : undefined;
      if (parsed) documents.set(message.requestId, parsed);
      return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
        value: parsed ? parsed.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options)
      } };
    });
    await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderPresetPosition(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(init => window.dispatchEvent(new MessageEvent('message', { data: init })), {
      type: 'init', documentId: 'file:///preset-position.md', text: markdown, version: 1, savedRevision: { version: 1, text: markdown },
      diagnostics: [], mode: 'preview', uiLanguage: 'en', editorAppearance: appearance, sourceLineNumbers: 'on',
      previewAppearance: appearance, previewFontFamily: 'Georgia', previewSourceColoring: true, previewShowComments: false,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      vscodeTheme: null, customPreviewPresets: library.list()
    });
    const waitPreset = (preset: string) => page.waitForFunction(preset =>
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, preset);
    await waitPreset('default');
    if (surface !== 'preview') {
      await page.waitForSelector('[data-mode="source"]', { visible: true });
      await page.click('[data-mode="source"]');
      if (await page.$eval('.source-preview-button', element => element.getAttribute('aria-pressed') !== 'true')) {
        await page.waitForSelector('.source-preview-button', { visible: true });
        await page.click('.source-preview-button');
      }
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')!.inert && !document.querySelector<HTMLElement>('.preview-host')!.hidden);
      const linked = surface === 'linked-source';
      await page.waitForSelector('.source-preview-scroll-sync-button', { visible: true });
      if (await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed') === 'true') !== linked) await page.click('.source-preview-scroll-sync-button');
      assert.equal(await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed')), String(linked));
    }
    const choose = async (preset: string) => {
      // Render metadata can arrive before the atomic surface handoff exposes its
      // controls. Wait for the actual click targets while retaining frame sampling.
      if (surface !== 'preview' && await page.$eval('.source-preview-more-panel', element => (element as HTMLElement).hidden)) {
        await page.waitForSelector('.source-preview-more-button', { visible: true });
        await page.click('.source-preview-more-button');
      }
      await page.waitForSelector('.preview-preset-dropdown', { visible: true });
      await page.click('.preview-preset-dropdown');
      await page.waitForSelector(`.preview-preset-dropdown-panel [data-value="${preset}"]`, { visible: true });
      await page.click(`.preview-preset-dropdown-panel [data-value="${preset}"]`);
    };
    // A content-relative point remains meaningful when the same paragraph wraps differently.
    const target = large ? 'Paragraph 95-2:' : 'Paragraph 5-2:';
    const progress = 0.37;
    const frameBounds = await page.$eval('.preview-frame', element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(frameBounds.x, frameBounds.y);
    await page.mouse.wheel({ deltaY: 80 });
    await settle();
    if (large) {
      // Explicit navigation mounts the actual distant reading band, rather
      // than mistaking an estimated gap for rendered document content.
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLAnchorElement>('a[data-meo-preview-href="#section-95"]')!.click());
      await page.waitForFunction(target => [...document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelectorAll('p')]
        .some(element => element.textContent!.startsWith(target)), {}, target);
      await settle(350);
    }
    await page.evaluate(({ target, progress }) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const paragraph = [...doc.querySelectorAll('p')].find(element => element.textContent!.startsWith(target))!;
      const rect = paragraph.getBoundingClientRect();
      doc.scrollingElement!.scrollTop += rect.top + rect.height * progress - doc.defaultView!.innerHeight / 3;
    }, { target, progress });
    // Establish the real Preview scroll driver after the distant navigation
    // and fixture positioning, so Source finishes following before sampling.
    await page.mouse.move(frameBounds.x, frameBounds.y);
    await page.mouse.wheel({ deltaY: 8 });
    await settle(350);
    // A height fraction changes meaning when a paragraph wraps. Retain an
    // immutable painted character and sample it through every presentation frame.
    const captureGlyph = () => page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const root = doc.querySelector('main.meo-export-doc')!, bounds = root.getBoundingClientRect();
      const range = doc.caretRangeFromPoint(Math.max(4, bounds.left + 12), doc.defaultView!.innerHeight / 3)!;
      if (range.startContainer.nodeType !== Node.TEXT_NODE || !root.contains(range.startContainer))
        throw new Error('Reading fixture needs painted paragraph text');
      const block = range.startContainer.parentElement!.closest<HTMLElement>('[data-source-line]')!;
      const prefix = doc.createRange(); prefix.selectNodeContents(block); prefix.setEnd(range.startContainer, range.startOffset);
      return { text: range.startContainer.textContent!, offset: prefix.toString().length, line: block.dataset.sourceLine! };
    });
    const initialGlyph = await captureGlyph();
    const witness = (point = initialGlyph) => page.evaluate(point => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const walker = doc.createTreeWalker(doc.querySelector(`[data-source-line="${point.line}"]`)!, NodeFilter.SHOW_TEXT);
      let remaining = point.offset;
      while (walker.nextNode()) {
        const length = walker.currentNode.textContent!.length;
        if (remaining < length) {
          const range = doc.createRange(); range.setStart(walker.currentNode, remaining); range.collapse(true);
          return range.getBoundingClientRect().top;
        }
        remaining -= length;
      }
      throw new Error('Unchanged reading character disappeared');
    }, point);
    const initialPoint = await witness();
    const startSampling = async (readingPoint?: { text: string; offset: number; line: string }) => page.evaluate(point => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const read = () => {
        const block = doc.querySelector(`[data-source-line="${point.line}"]`);
        if (!block) return NaN;
        const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let remaining = point.offset;
        while (walker.nextNode()) {
          const length = walker.currentNode.textContent!.length;
          if (remaining < length) {
            const range = doc.createRange(); range.setStart(walker.currentNode, remaining); range.collapse(true);
            return range.getBoundingClientRect().top;
          }
          remaining -= length;
        }
        return NaN;
      };
      const probe = { active: true, expected: read(), samples: [] as number[] };
      (window as any).__presetPositionSamples = probe;
      const sample = () => {
        if (!probe.active) return;
        probe.samples.push(read());
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, readingPoint ?? initialGlyph);
    const assertSamples = async (label: string, expectedPoint?: number) => {
      const samples = await page.evaluate(() => {
        const probe = (window as any).__presetPositionSamples;
        probe.active = false;
        return { points: probe.samples as number[], expected: probe.expected as number };
      });
      assert.ok(samples.points.length >= 2, `${label}: must observe multiple frames`);
      assert.ok(samples.points.every(Number.isFinite), `${appearance}/${surface}/${label}: reading character disappeared during preset presentation`);
      const drift = Math.max(...samples.points.map(point => Math.abs(point - (expectedPoint ?? samples.expected))));
      assert.ok(drift <= 2, `${appearance}/${surface}/${label}: reading point moved ${drift}px`);
    };
    for (const preset of ['github-readme', custom.id, 'default', 'newsprint', 'whitey', 'obsidian-minimal', custom.id, 'github-readme', 'default']) {
      await startSampling();
      await choose(preset);
      await waitPreset(preset);
      await settle();
      await assertSamples(preset, initialPoint);
      if (large) assert.ok(await page.$eval('.preview-frame', element =>
        (element as HTMLIFrameElement).contentDocument!.querySelector('main')!.childElementCount) < 100,
      `${preset}: preset comparison must retain bounded reading DOM`);
    }
    await startSampling();
    const lateSwitch = holdNextResponse();
    await choose('github-readme');
    await choose(custom.id);
    await choose('default');
    assert.equal(lateSwitch.requested, true, 'Rapid switching must exercise a pending response');
    lateSwitch.release();
    await waitPreset('default');
    await settle(350);
    await assertSamples('rapid switching with a late response', initialPoint);

    const lateScroll = holdNextResponse();
    await choose(custom.id);
    assert.equal(lateScroll.requested, true, 'Scrolling must happen while a response is pending');
    await page.mouse.move(frameBounds.x, frameBounds.y);
    await page.mouse.wheel({ deltaY: 300 });
    await settle(350);
    assert.ok(Math.abs(await witness() - initialPoint) > 100, 'Trusted scrolling must move the reading point');
    const scrolledReadingPoint = await captureGlyph();
    const scrolledPoint = await witness(scrolledReadingPoint);
    await startSampling(scrolledReadingPoint);
    lateScroll.release();
    await waitPreset(custom.id);
    await settle();
    await assertSamples('late response after user scrolling', scrolledPoint);

    if (surface === 'preview' && !large) {
      // A trusted Source interaction ends the earlier Preview mode chain. Its
      // ordinary-line projection has no rendered range and must retain the band.
      await page.click('[data-mode="source"]');
      // This case starts with a settled Source projection; rapid mode-entry input is covered separately.
      await page.evaluate(async () => {
        let previous = '';
        let stableFrames = 0;
        for (let frame = 0; frame < 120; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
          const current = [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(':');
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3 && scroller.clientHeight > 0) return;
        }
        throw new Error('Source reading surface did not settle before trusted scrolling');
      });
      const sourceBounds = await page.$eval('.cm-scroller', element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      // Explicitly focus Source after leaving the iframe before beginning its wheel gesture.
      await page.mouse.click(sourceBounds.x, sourceBounds.y);
      await settle();
      const sourceGesture = await page.$eval('.cm-scroller', element => {
        const bounds = element.getBoundingClientRect();
        const band = bounds.top + element.clientHeight / 3;
        const paragraph = [...element.querySelectorAll<HTMLElement>('.cm-line')].find(line => {
          const rect = line.getBoundingClientRect();
          return line.textContent!.startsWith('**Paragraph ') && rect.bottom > band + 40 && rect.top < bounds.bottom;
        });
        if (!paragraph) throw new Error('Source gesture needs visible ordinary text below the reading band');
        const rect = paragraph.getBoundingClientRect();
        return { top: element.scrollTop, deltaY: Math.max(rect.top + rect.height * 0.37, Math.min(rect.bottom - 4, band + 40)) - band };
      });
      await page.mouse.move(sourceBounds.x, sourceBounds.y);
      await page.mouse.wheel({ deltaY: sourceGesture.deltaY });
      await page.waitForFunction(previous => document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop !== previous, {}, sourceGesture.top);
      await settle(350);
      await page.click('[data-mode="preview"]');
      await settle(350);
      const roundtripPoint = await captureGlyph();
      const roundtripExpected = await witness(roundtripPoint);
      await startSampling(roundtripPoint);
      await choose('github-readme');
      await waitPreset('github-readme');
      await settle();
      await assertSamples('preset after a fresh Source reading projection', roundtripExpected);
    }

    if (!large) {
      await choose('default');
      await waitPreset('default');
      await settle();
      await page.mouse.move(frameBounds.x, frameBounds.y);
      await page.mouse.wheel({ deltaY: 8 });
      await settle(350);
      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const code = [...doc.querySelectorAll('p code')].find(element => element.textContent === 'inline_probe_5()')!;
        // Accepted highlighting may nest the glyph in a token span. Switching
        // renderer flattens that span while preserving the authored paragraph.
        const first = doc.createElement('span'), second = doc.createElement('span');
        first.textContent = 'inline_'; second.textContent = 'probe_5()';
        code.replaceChildren(first, second);
        const node = doc.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = doc.createRange(); range.setStart(node, 0); range.collapse(true);
        doc.scrollingElement!.scrollTop += range.getBoundingClientRect().top - doc.defaultView!.innerHeight / 3;
      });
      await page.mouse.move(frameBounds.x, frameBounds.y);
      await page.mouse.wheel({ deltaY: 8 });
      await settle(350);
      const inlinePoint = await captureGlyph();
      assert.equal(inlinePoint.text, 'inline_', 'The inline regression must read the actual code token glyph');
      const inlineTop = await witness(inlinePoint);
      for (const preset of ['github-readme', 'default']) {
        await startSampling(inlinePoint);
        await choose(preset);
        await waitPreset(preset);
        await settle();
        await assertSamples(`inline code/${preset}`, inlineTop);
      }
    }
    await page.evaluate(() => { document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0; });
    await settle();
    for (const preset of ['default', 'github-readme', custom.id, 'default']) {
      await choose(preset);
      await waitPreset(preset);
      await settle();
      assert.equal(await page.$eval('.preview-frame', element => (element as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop), 0, `${preset}: the document start stays at the start`);
    }
    assert.deepEqual(errors, []);
    console.log(`Preview preset position: ${appearance}/${surface} passed`);
    await page.close();
    for (const document of documents.values()) document.dispose();
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
  else await closeTestBrowser(browser);
}
console.log('Preview preset position checks passed');
