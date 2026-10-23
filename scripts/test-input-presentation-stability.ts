import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser } from './browser-test-helpers';
import { createLargeDocumentFixtures } from './large-document-fixtures';
import { browser, server, open, frames, assertStablePaint, captureResult, observedPaints } from './input-presentation-test-helpers';

let primaryError: unknown;
let stage = 'startup';
const richOnly = process.argv.includes('--rich-only'), stickyOnly = process.argv.includes('--sticky-only'), heightOnly = process.argv.includes('--height-only');
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
    const doc = (element as HTMLIFrameElement).contentDocument!;
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const edited = doc.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
    // Font metrics can put the edited glyphs across the old fixed 120px crop.
    // Compare only unchanged content below the actual input paragraph.
    const top = Math.ceil(rect.top + Math.max(120, (edited?.getBoundingClientRect().bottom ?? 0) + 8));
    return { left: Math.ceil(rect.left + 25), top, width: Math.floor(rect.width - 50), height: Math.floor(rect.bottom - top - 30) };
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
  if (!richOnly && !stickyOnly && !heightOnly) {
    stage = 'Source split Preview crosses its presentation budget';
    const text = 'Typing target.\n\n# Stable reading witness\n\nUnchanged reading paragraph.\n\n'
      + '~~~\nplain fixture\n~~~\n\n'.repeat(127);
    const extra = '~~~\nnew block\n~~~\n\n';
    const page = await browser.newPage(), host = await open(page, text, true);
    try {
      await page.click('.source-preview-button');
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden
        && !document.querySelector<HTMLElement>('.preview-host')?.inert
        && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility === 'visible'
        && document.querySelector<HTMLElement>('.preview-loading')?.hidden
        && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1'));
      if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true')) {
        await page.click('.source-preview-scroll-sync-button');
      }
      await page.evaluate(() => {
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus();
        document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 0;
      });
      await frames(page, 12);
      assert.equal(await page.$eval('.preview-frame', frame => (frame as HTMLIFrameElement).contentDocument!
        .documentElement.dataset.meoPreviewWindowed), 'false');
      const before = await page.$eval('.preview-frame', frame => (frame as HTMLIFrameElement).contentDocument!.querySelector('h1')!.getBoundingClientRect().top);
      const clip = await page.$eval('.preview-frame', frame => {
        const r = frame.getBoundingClientRect();
        return { left: Math.ceil(r.left + 25), top: Math.ceil(r.top + 20), width: Math.floor(r.width - 60), height: Math.floor(r.height - 50) };
      });
      for (const windowed of [true, false]) {
        await assertStablePaint(page, clip, async () => {
          if (windowed) await page.keyboard.sendCharacter(extra);
          else { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); }
          await page.waitForFunction(windowed => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument!
            .documentElement.dataset.meoPreviewWindowed === String(windowed), {}, windowed);
          await new Promise(resolve => setTimeout(resolve, 800)); await frames(page, 6);
        }, `Source split Preview presentation budget ${windowed}`);
        const after = await page.$eval('.preview-frame', frame => (frame as HTMLIFrameElement).contentDocument!.querySelector('h1')!.getBoundingClientRect().top);
        assert.ok(Math.abs(after - before) <= 1, 'Preview admission must preserve its independent reading position');
        assert.equal(host.readHost(), text + (windowed ? extra : ''));
      }
      assert.deepEqual(host.errors, []);
    } finally { host.dispose(); await page.close(); }
  }
  const paragraphs = 'Typing target.\n\n' + Array.from({ length: 70 }, (_, index) => `Unchanged paragraph ${index}.`).join('\n\n');
  for (const windowed of richOnly || stickyOnly || heightOnly ? [] : [false, true]) for (const sync of [false, true]) {
    const text = paragraphs + (windowed ? '\n\n' + Array.from({ length: 5000 }, (_, index) => `Far paragraph ${index}.\n\n`).join('') : '');
    stage = `Source split Preview, windowed ${windowed}, sync ${sync}`;
    const page = await browser.newPage(), host = await open(page, text, true);
    try {
      await page.locator('.source-preview-button').click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden
        && !document.querySelector<HTMLElement>('.preview-host')?.inert
        && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility === 'visible'
        && document.querySelector<HTMLElement>('.preview-loading')?.hidden
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
        return { scroll: doc.scrollingElement!.scrollTop, top: reading.getBoundingClientRect().top,
          font: doc.defaultView!.getComputedStyle(reading).fontSize, height: doc.body.getBoundingClientRect().height };
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
          if (!windowed && key === 'Enter') {
            // Observe the intermediate rendered line break. A fast Backspace
            // used to coalesce it away and miss fractional reading drift.
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!
              .contentDocument!.querySelector('p br'));
          }
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
        if (!windowed && frame.height === baseline.height) assert.ok(Math.abs(frame.scroll - baseline.scroll) <= 1,
          `${stage}: unchanged layout scrolled the follower: ${JSON.stringify({ baseline, frame })}`);
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
