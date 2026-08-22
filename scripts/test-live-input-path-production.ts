import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-input-path-'));

type FrameSample = {
  text: string;
  domText: string;
  applyCount: number;
  selectionText: string;
  tableCount: number;
  caretVisible: boolean;
  derivedAdditions: number;
  tableProjectionEvents: number;
  searchEvents: number;
  derivedMutationKinds: string[];
};

async function waitForFrames(page: import('puppeteer-core').Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function armFirstFrame(
  page: import('puppeteer-core').Page,
  eventName: 'beforeinput' | 'paste' | 'compositionend'
): Promise<void> {
  await page.evaluate((inputEventName) => {
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('CodeMirror content was not mounted');
    const editorRoot = content.closest<HTMLElement>('.cm-editor');
    if (!editorRoot) throw new Error('CodeMirror root was not mounted');
    (window as any).__liveInputFirstFrame = new Promise<FrameSample>((resolve) => {
      content.addEventListener(inputEventName, () => {
        let derivedAdditions = 0;
        let tableProjectionEvents = 0;
        let searchEvents = 0;
        const derivedMutationKinds: string[] = [];
        const derivedSelector = '.meo-md-marker, .meo-md-html-table-shell, .meo-md-list-marker, .meo-md-long-code-placeholder, .meo-md-long-code-footer';
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node.matches(derivedSelector)) {
                derivedAdditions += 1;
                derivedMutationKinds.push(node.className);
              }
              const descendants = node.querySelectorAll<HTMLElement>(derivedSelector);
              derivedAdditions += descendants.length;
              derivedMutationKinds.push(...Array.from(descendants, (element) => element.className));
            }
          }
        });
        const onProjection = () => { tableProjectionEvents += 1; };
        const onSearch = () => { searchEvents += 1; };
        observer.observe(content, { childList: true, subtree: true });
        editorRoot.addEventListener('meo-table-column-width-projected', onProjection, { capture: true });
        editorRoot.addEventListener('meo-search-state-change', onSearch, { capture: true });
        const snapshot = (): FrameSample => {
          const editor = (window as any).__liveInputEditor;
          const selection = document.getSelection();
          const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
          const viewport = content.closest<HTMLElement>('.cm-scroller')?.getBoundingClientRect() ?? null;
          return {
            text: editor.getText(),
            domText: content.textContent ?? '',
            applyCount: (window as any).__liveInputApplies.length,
            selectionText: selection?.toString() ?? '',
            tableCount: document.querySelectorAll('#primary .meo-md-html-table-shell').length,
            caretVisible: Boolean(caret && viewport && caret.bottom >= viewport.top && caret.top <= viewport.bottom),
            derivedAdditions,
            tableProjectionEvents,
            searchEvents,
            derivedMutationKinds: [...derivedMutationKinds]
          };
        };
        (window as any).__liveInputSettledFrame = new Promise<FrameSample>((resolveSettled) => {
          requestAnimationFrame(() => {
            setTimeout(() => resolve(snapshot()), 0);
            let remainingFrames = 3;
            const settleAfterPaint = () => requestAnimationFrame(() => {
              remainingFrames -= 1;
              if (remainingFrames > 0) {
                settleAfterPaint();
                return;
              }
              setTimeout(() => {
                const sample = snapshot();
                observer.disconnect();
                editorRoot.removeEventListener('meo-table-column-width-projected', onProjection, { capture: true });
                editorRoot.removeEventListener('meo-search-state-change', onSearch, { capture: true });
                resolveSettled(sample);
              }, 0);
            });
            settleAfterPaint();
          });
        });
      }, { capture: true, once: true });
    });
  }, eventName);
}

async function readFirstFrame(page: import('puppeteer-core').Page): Promise<FrameSample> {
  return page.evaluate(() => (window as any).__liveInputFirstFrame);
}

async function readSettledFrame(page: import('puppeteer-core').Page): Promise<FrameSample> {
  return page.evaluate(() => (window as any).__liveInputSettledFrame);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-input-cursor-navigation-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
      <style>html,body,#app{height:100%;margin:0}#app{display:flex}.editor{min-width:0;flex:1}</style>
      <div id="app"><div id="primary" class="editor"></div><div id="secondary" class="editor"></div></div>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const longCode = Array.from({ length: 19 }, (_, index) => `const liveLine${index + 1} = ${index + 1};`);
    const coreOriginal = 'plain line\n**marked text**\n\n| A | B |\n| --- | --- |\n| cell | value |\nlast line';
    const original = [
      'plain line',
      '**marked text**',
      '',
      '| A | B |',
      '| --- | --- |',
      '| cell | value |',
      '',
      '<details open>',
      '<summary>Details</summary>',
      'Body',
      '</details>',
      '',
      '```js',
      ...longCode,
      '```',
      'last line'
    ].join('\n');
    await page.evaluate((text) => {
      const create = (window as any).__createInputCursorEditor;
      (window as any).__liveInputApplies = [];
      (window as any).__secondaryApplies = [];
      (window as any).__liveInputEditor = create({
        parent: document.getElementById('primary'),
        text,
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__liveInputApplies.push(nextText);
        }
      });
      (window as any).__secondaryEditor = create({
        parent: document.getElementById('secondary'),
        text: 'second editor',
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__secondaryApplies.push(nextText);
        }
      });
    }, original);
    await waitForFrames(page, 6);

    const initialTableCount = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-html-table-shell').length
    ));
    if (initialTableCount !== 1) {
      throw new Error(`Live table fixture did not render: ${initialTableCount}`);
    }
    const initialOneShotFixture = await page.evaluate(() => ({
      detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
      longCodePlaceholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    }));
    if (initialOneShotFixture.detailsOpen !== true || initialOneShotFixture.longCodePlaceholders !== 1) {
      throw new Error(`Live one-shot fixture did not render: ${JSON.stringify(initialOneShotFixture)}`);
    }

    const pendingDetailsAndFolding = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'D');
      const toggled = (window as any).__toggleFirstDetails(editor);
      editor.setLongCodeBlockFoldingEnabled(false);
      return {
        toggled,
        detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
      };
    });
    await waitForFrames(page, 5);
    const settledDetailsAndFolding = await page.evaluate(() => ({
      detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
      placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    }));
    if (
      !pendingDetailsAndFolding.toggled || pendingDetailsAndFolding.detailsOpen !== false ||
      pendingDetailsAndFolding.placeholders !== 0 || settledDetailsAndFolding.detailsOpen !== false ||
      settledDetailsAndFolding.placeholders !== 0
    ) {
      throw new Error(`Pending input swallowed a details/folding command: ${JSON.stringify({ pendingDetailsAndFolding, settledDetailsAndFolding })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__toggleFirstDetails(editor);
      editor.setLongCodeBlockFoldingEnabled(true);
      editor.setSearchQuery('');
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingSearchReveal = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'S');
      const result = editor.findNext('const liveLine19 = 19;', { focusEditor: false });
      return {
        found: result?.found,
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
      };
    });
    await waitForFrames(page, 5);
    const settledSearchReveal = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    ));
    if (pendingSearchReveal.found !== true || pendingSearchReveal.placeholders !== 0 || settledSearchReveal !== 0) {
      throw new Error(`Pending input swallowed or replayed search reveal: ${JSON.stringify({ pendingSearchReveal, settledSearchReveal })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setSearchQuery('');
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingToggle = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'T');
      document.querySelector<HTMLButtonElement>('#primary .meo-md-long-code-placeholder .meo-long-code-action')?.click();
      return document.querySelectorAll('#primary .meo-md-long-code-placeholder').length;
    });
    await waitForFrames(page, 5);
    const settledToggle = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    ));
    if (pendingToggle !== 0 || settledToggle !== 0) {
      throw new Error(`Pending input swallowed or replayed long-code toggle: ${JSON.stringify({ pendingToggle, settledToggle })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingPointer = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'P');
      const line = Array.from(document.querySelectorAll<HTMLElement>('#primary .meo-md-code-line-numbered'))
        .find((candidate) => candidate.textContent?.includes('const liveLine1 = 1;'));
      const rect = line?.getBoundingClientRect();
      if (!line || !rect) throw new Error('Missing visible long-code line for pointer command');
      line.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 19,
        clientX: rect.left + 8,
        clientY: rect.top + rect.height / 2
      }));
      return document.querySelectorAll('#primary .meo-md-long-code-placeholder').length;
    });
    await waitForFrames(page, 5);
    const settledPointer = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    ));
    if (pendingPointer !== 0 || settledPointer !== 0) {
      throw new Error(`Pending input swallowed or replayed long-code pointer command: ${JSON.stringify({ pendingPointer, settledPointer })}`);
    }

    await page.evaluate((text) => {
      (window as any).__liveInputEditor.setText(text, true);
      document.querySelector<HTMLButtonElement>('#primary .meo-md-long-code-footer .meo-long-code-action')?.click();
    }, original);
    await waitForFrames(page, 5);

    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      editor.revealSelection('plain '.length, 'plain '.length, { focusEditor: true, align: 'nearest' });
    });
    await waitForFrames(page, 2);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('X');
    const plainImmediate = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      applies: [...(window as any).__liveInputApplies]
    }));
    const plainFrame = await readFirstFrame(page);
    if (
      !plainImmediate.text.startsWith('plain Xline') ||
      plainImmediate.applies.at(-1) !== plainImmediate.text ||
      plainFrame.text !== plainImmediate.text ||
      !plainFrame.domText.includes('plain Xline') ||
      plainFrame.selectionText !== '' ||
      !plainFrame.caretVisible ||
      plainFrame.tableCount !== 1 ||
      plainFrame.derivedAdditions !== 0 ||
      plainFrame.tableProjectionEvents !== 0 ||
      plainFrame.searchEvents !== 0
    ) {
      throw new Error(`Plain input was not committed and visible before derived work: ${JSON.stringify({ plainImmediate, plainFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const markerStart = text.indexOf('marked');
      editor.revealSelection(markerStart, markerStart + 'marked'.length, {
        focusEditor: true,
        align: 'nearest'
      });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Q');
    const markerFrame = await readFirstFrame(page);
    if (!markerFrame.text.includes('**Q text**') || !markerFrame.domText.includes('Q text') || !markerFrame.caretVisible) {
      throw new Error(`Markdown-adjacent replacement was hidden or reverted: ${JSON.stringify(markerFrame)}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const blankLine = text.indexOf('\n\n|') + 1;
      editor.revealSelection(blankLine, blankLine, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Z');
    const boundaryFrame = await readFirstFrame(page);
    const boundarySettled = await readSettledFrame(page);
    if (
      !boundaryFrame.text.includes('**marked text**\nZ\n| A | B |') ||
      !boundaryFrame.domText.includes('Z') ||
      boundaryFrame.tableCount !== 0 ||
      boundaryFrame.derivedAdditions !== 0 ||
      boundaryFrame.tableProjectionEvents !== 0 ||
      boundaryFrame.searchEvents !== 0 ||
      boundarySettled.tableCount !== 1 ||
      boundarySettled.derivedAdditions === 0 ||
      boundarySettled.tableProjectionEvents === 0 ||
      boundarySettled.searchEvents === 0 ||
      boundarySettled.text !== boundaryFrame.text
    ) {
      throw new Error(`Rendered-block boundary did not preserve primary text and the unaffected block: ${JSON.stringify({ boundaryFrame, boundarySettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await armFirstFrame(page, 'paste');
    const pasteHandled = await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', ' PASTE');
      return !document.querySelector<HTMLElement>('#primary .cm-content')!.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      }));
    });
    const pasteFrame = await readFirstFrame(page);
    if (!pasteHandled || !pasteFrame.text.startsWith('plain PASTE line') || !pasteFrame.domText.includes('plain PASTE line') || !pasteFrame.caretVisible) {
      throw new Error(`Paste was not committed and visible on its first frame: ${JSON.stringify({ pasteHandled, pasteFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain line'.length, 'plain line'.length, { focusEditor: true, align: 'nearest' });
    }, coreOriginal);
    await waitForFrames(page, 2);
    const beforeImeApplyCount = await page.evaluate(() => (window as any).__liveInputApplies.length);
    const session = await page.createCDPSession();
    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.imeSetComposition', { text: 'long-preedit', selectionStart: 12, selectionEnd: 12 });
    const preeditFirstFrame = await readFirstFrame(page);
    const preeditFourthFrame = await readSettledFrame(page);
    if (
      !preeditFirstFrame.text.startsWith('plain linelong-preedit') ||
      !preeditFourthFrame.domText.includes('long-preedit') ||
      preeditFourthFrame.applyCount !== beforeImeApplyCount ||
      preeditFourthFrame.derivedAdditions !== 0 ||
      preeditFourthFrame.tableProjectionEvents !== 0 ||
      preeditFourthFrame.searchEvents !== 0
    ) {
      throw new Error(`Long IME preedit triggered derived work: ${JSON.stringify({ preeditFirstFrame, preeditFourthFrame })}`);
    }

    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.imeSetComposition', { text: '拼', selectionStart: 1, selectionEnd: 1 });
    await session.send('Input.insertText', { text: '拼' });
    const imeFrame = await readFirstFrame(page);
    const imeSettled = await readSettledFrame(page);
    if (
      !imeFrame.text.startsWith('plain line拼') ||
      !imeFrame.domText.includes('plain line拼') ||
      !imeFrame.caretVisible ||
      imeFrame.derivedAdditions !== 0 ||
      imeFrame.tableProjectionEvents !== 0 ||
      imeFrame.searchEvents !== 0 ||
      imeSettled.applyCount !== beforeImeApplyCount + 1 ||
      imeSettled.derivedAdditions === 0
    ) {
      throw new Error(`IME commit did not preserve preedit/commit ownership: ${JSON.stringify({ imeFrame, imeSettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain line'.length, 'plain line'.length, { focusEditor: true, align: 'nearest' });
    }, coreOriginal);
    await waitForFrames(page, 2);
    const beforeImeCancelApplyCount = await page.evaluate(() => (window as any).__liveInputApplies.length);
    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.imeSetComposition', { text: 'cancel-preedit', selectionStart: 14, selectionEnd: 14 });
    const cancelPreeditFirst = await readFirstFrame(page);
    const cancelPreeditSettled = await readSettledFrame(page);
    if (
      !cancelPreeditFirst.text.startsWith('plain linecancel-preedit') ||
      cancelPreeditSettled.applyCount !== beforeImeCancelApplyCount ||
      cancelPreeditSettled.derivedAdditions !== 0 ||
      cancelPreeditSettled.tableProjectionEvents !== 0 ||
      cancelPreeditSettled.searchEvents !== 0
    ) {
      throw new Error(`IME cancel preedit triggered derived work: ${JSON.stringify({ cancelPreeditFirst, cancelPreeditSettled })}`);
    }
    await armFirstFrame(page, 'compositionend');
    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      const cancelFrom = 'plain line'.length;
      (window as any).__dispatchProductionInput(editor, cancelFrom, '', cancelFrom + 'cancel-preedit'.length);
      document.querySelector<HTMLElement>('#primary .cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
        data: '',
        bubbles: true
      }));
    });
    const imeCancelFrame = await readFirstFrame(page);
    const imeCancelSettled = await readSettledFrame(page);
    if (
      imeCancelFrame.text !== coreOriginal ||
      imeCancelFrame.derivedAdditions !== 0 ||
      imeCancelFrame.tableProjectionEvents !== 0 ||
      imeCancelFrame.searchEvents !== 0 ||
      imeCancelSettled.applyCount !== beforeImeCancelApplyCount + 1 ||
      imeCancelSettled.derivedAdditions === 0
    ) {
      throw new Error(`IME cancel did not restore and refresh the committed document once: ${JSON.stringify({ imeCancelFrame, imeCancelSettled })}`);
    }

    const orderedList = '1. alpha\n1. beta';
    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection(text.length, text.length, { focusEditor: true, align: 'nearest' });
    }, orderedList);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('!');
    const orderedFrame = await readFirstFrame(page);
    const orderedSettled = await readSettledFrame(page);
    const orderedLatestApply = await page.evaluate(() => (window as any).__liveInputApplies.at(-1));
    if (
      orderedFrame.text !== '1. alpha\n2. beta!' ||
      orderedLatestApply !== orderedFrame.text ||
      !orderedFrame.domText.includes('beta!') ||
      orderedFrame.derivedAdditions !== 0 ||
      orderedFrame.searchEvents !== 0 ||
      orderedSettled.text !== orderedFrame.text ||
      !orderedSettled.derivedMutationKinds.some((kind) => kind.includes('meo-md-list-marker'))
    ) {
      throw new Error(`Ordered-list input follow-up escaped the input phase: ${JSON.stringify({ orderedFrame, orderedSettled, orderedLatestApply })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await page.keyboard.type('abcdef');
    const burst = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      latestApply: (window as any).__liveInputApplies.at(-1)
    }));
    await page.evaluate(() => (window as any).__liveInputEditor.setText('external reload wins', true));
    await waitForFrames(page, 4);
    const currentness = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? ''
    }));
    if (!burst.text.startsWith('plainabcdef line') || burst.latestApply !== burst.text || currentness.text !== 'external reload wins' || !currentness.domText.includes('external reload wins')) {
      throw new Error(`Burst/reload currentness failed: ${JSON.stringify({ burst, currentness })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__secondaryEditor;
      editor.revealSelection(editor.getText().length, editor.getText().length, { focusEditor: true, align: 'nearest' });
    });
    await page.keyboard.type(' remains');
    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, editor.getText().length, 'M');
      editor.setMode('source');
    });
    await waitForFrames(page, 4);
    const modeSupersede = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? '',
      sourceMode: document.querySelector('#primary .cm-editor')?.classList.contains('meo-mode-source')
    }));
    if (
      modeSupersede.text !== 'external reload winsM' ||
      !modeSupersede.domText.includes('external reload winsM') ||
      modeSupersede.sourceMode !== true
    ) {
      throw new Error(`Mode supersede did not preserve the latest primary document: ${JSON.stringify(modeSupersede)}`);
    }
    await page.evaluate(() => (window as any).__liveInputEditor.destroy());
    const isolation = await page.evaluate(() => ({
      secondaryText: (window as any).__secondaryEditor.getText(),
      secondaryApply: (window as any).__secondaryApplies.at(-1),
      secondaryDom: document.querySelector<HTMLElement>('#secondary .cm-content')?.textContent ?? '',
      primaryConnected: Boolean(document.querySelector('#primary .cm-editor'))
    }));
    if (
      isolation.secondaryText !== 'second editor remains' ||
      isolation.secondaryApply !== isolation.secondaryText ||
      !isolation.secondaryDom.includes('second editor remains') ||
      isolation.primaryConnected
    ) {
      throw new Error(`Destroy/multi-editor isolation failed: ${JSON.stringify(isolation)}`);
    }

    console.log('Live input production frame trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
