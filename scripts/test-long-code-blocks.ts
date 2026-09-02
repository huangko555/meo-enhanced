import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-long-code-blocks-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-long-code-blocks-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.evaluate(() => {
      const nativeAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
      const heldCallbacks = new Map<number, FrameRequestCallback>();
      let holding = false;
      let holdNext = false;
      let nextHeldId = -1;
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        if (!holding && !holdNext) return nativeAnimationFrame(callback);
        holdNext = false;
        const id = nextHeldId;
        nextHeldId -= 1;
        heldCallbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id: number) => {
        if (!heldCallbacks.delete(id)) nativeCancelAnimationFrame(id);
      };
      (window as any).__longCodeFrameGate = {
        hold() { holding = true; },
        holdNext() { holdNext = true; },
        open() { holding = false; holdNext = false; },
        pending() { return heldCallbacks.size; },
        takeFrame() {
          const callbacks = [...heldCallbacks.values()];
          heldCallbacks.clear();
          return {
            count: callbacks.length,
            run() {
              const timestamp = performance.now();
              for (const callback of callbacks) callback(timestamp);
            }
          };
        }
      };
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text: string) {
            (window as any).__copiedLongCode = text;
            return Promise.resolve();
          }
        }
      });
    });

    const localizedLongCode = [
      '```js',
      ...Array.from({ length: 19 }, (_, index) => `const localized${index + 1} = ${index + 1};`),
      '```'
    ].join('\n');
    const localizedLongCodeLabels = await page.evaluate(async (content) => {
      const editor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const read = () => {
        const button = document.querySelector<HTMLButtonElement>(
          '.meo-md-long-code-placeholder .meo-long-code-action'
        );
        return {
          text: button?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          label: button?.getAttribute('aria-label') ?? ''
        };
      };
      const chinese = read();
      editor.setUiLanguage('en');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const english = read();
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      return { chinese, english };
    }, localizedLongCode);
    if (
      localizedLongCodeLabels.chinese.text !== '显示其余 9 行' ||
      localizedLongCodeLabels.chinese.label !== '显示其余 9 行代码' ||
      localizedLongCodeLabels.english.text !== 'Show 9 more lines' ||
      localizedLongCodeLabels.english.label !== 'Show 9 more lines of code'
    ) {
      throw new Error(`Live long-code controls did not update their language in place: ${JSON.stringify(localizedLongCodeLabels)}`);
    }

    for (const bareOpeningFence of ['```', '```js']) {
      const bareFenceState = await page.evaluate((content) => {
        const editor = (window as any).LongCodeBlocksHarness.createEditor({
          parent: document.getElementById('app')!,
          text: content,
          initialMode: 'live',
          onApplyChanges() {}
        });
        const state = {
          text: editor.getText(),
          placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
          footers: document.querySelectorAll('.meo-md-long-code-footer').length
        };
        editor.destroy();
        document.getElementById('app')!.replaceChildren();
        return state;
      }, bareOpeningFence);
      if (
        bareFenceState.text !== bareOpeningFence ||
        bareFenceState.placeholders !== 0 ||
        bareFenceState.footers !== 0
      ) {
        throw new Error(`Bare unclosed opening fence did not degrade safely: ${JSON.stringify({ bareOpeningFence, bareFenceState })}`);
      }
    }

    const replacementBlock = (label: string, codeLineCount = 24) => [
      '```js',
      ...Array.from({ length: codeLineCount }, (_, index) => `const ${label}${index + 1} = ${index + 1};`),
      '```',
      '',
      ...Array.from({ length: 80 }, (_, index) => `${label} trailing prose ${index + 1}`)
    ].join('\n');
    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, replacementBlock('manualOld'));
    await waitForFrames(page);
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor.setText(content, true);
    }, replacementBlock('manualNew'));
    await waitForFrames(page);
    const manualReplacement = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length,
      text: (window as any).__longCodeBlocksEditor.getText()
    }));
    if (
      manualReplacement.placeholders !== 1 || manualReplacement.footers !== 0 ||
      !manualReplacement.text.includes('manualNew24')
    ) {
      throw new Error(`External replacement inherited manual fold UI: ${JSON.stringify(manualReplacement)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const target = editor.getText().indexOf('manualNew20');
      editor.revealSelection(target, target, { focusEditor: true, align: 'nearest' });
    });
    await waitForFrames(page);
    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor.setText(content, true);
    }, replacementBlock('temporaryNew'));
    await waitForFrames(page);
    const temporaryReplacement = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length,
      text: (window as any).__longCodeBlocksEditor.getText()
    }));
    if (
      temporaryReplacement.placeholders !== 1 || temporaryReplacement.footers !== 0 ||
      !temporaryReplacement.text.includes('temporaryNew24')
    ) {
      throw new Error(`External replacement inherited temporary fold UI: ${JSON.stringify(temporaryReplacement)}`);
    }

    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor.setText(content, true);
    }, replacementBlock('raceOld', 100));
    await waitForFrames(page);
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await page.evaluate(() => {
      const scroller = (window as any).__longCodeBlocksEditor.getScrollElement();
      scroller.scrollTop = scroller.scrollHeight * 0.35;
    });
    await waitForFrames(page);
    const lateMeasureReplacement = await page.evaluate(async (content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      const floating = document.querySelector<HTMLButtonElement>('.meo-long-code-floating-action');
      if (!floating || floating.hidden) throw new Error('Missing floating collapse action for replacement race');
      const frameGate = (window as any).__longCodeFrameGate;
      frameGate.hold();
      floating.click();
      const scroller = editor.getScrollElement();
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const oldMeasureFrame = frameGate.takeFrame();
      frameGate.open();
      editor.setText(content, true);
      const target = editor.getText().indexOf('generationNew trailing prose 70');
      editor.revealSelection(target, target, { focusEditor: true, align: 'nearest' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const beforeLateCallbacks = editor.getTopVisiblePosition();
      oldMeasureFrame.run();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterLateCallbacks = editor.getTopVisiblePosition();
      return {
        oldMeasureFrames: oldMeasureFrame.count,
        beforeLateCallbacks,
        afterLateCallbacks,
        placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
        footers: document.querySelectorAll('.meo-md-long-code-footer').length
      };
    }, replacementBlock('generationNew', 100));
    if (
      lateMeasureReplacement.oldMeasureFrames === 0 ||
      lateMeasureReplacement.placeholders !== 1 || lateMeasureReplacement.footers !== 0 ||
      Math.abs(lateMeasureReplacement.afterLateCallbacks.line - lateMeasureReplacement.beforeLateCallbacks.line) > 1
    ) {
      throw new Error(`Late fold measure changed the replacement Document: ${JSON.stringify(lateMeasureReplacement)}`);
    }

    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, replacementBlock('rafOld', 100));
    await waitForFrames(page);
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await page.evaluate(() => {
      const scroller = (window as any).__longCodeBlocksEditor.getScrollElement();
      scroller.scrollTop = scroller.scrollHeight * 0.35;
    });
    await waitForFrames(page);
    const lateRafReplacement = await page.evaluate(async (content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      const floating = document.querySelector<HTMLButtonElement>('.meo-long-code-floating-action');
      if (!floating || floating.hidden) throw new Error('Missing floating collapse action for RAF replacement race');
      const frameGate = (window as any).__longCodeFrameGate;
      const scroller = editor.getScrollElement();
      let descriptorOwner: object | null = scroller;
      let scrollTopDescriptor: PropertyDescriptor | undefined;
      while (descriptorOwner && !scrollTopDescriptor) {
        scrollTopDescriptor = Object.getOwnPropertyDescriptor(descriptorOwner, 'scrollTop');
        descriptorOwner = Object.getPrototypeOf(descriptorOwner);
      }
      if (!scrollTopDescriptor?.get || !scrollTopDescriptor.set) {
        throw new Error('Browser scrollTop boundary is unavailable');
      }
      let scrollJumpCaptured = false;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTopDescriptor!.get!.call(scroller),
        set: (value: number) => {
          const before = scrollTopDescriptor!.get!.call(scroller) as number;
          scrollTopDescriptor!.set!.call(scroller, value);
          const after = scrollTopDescriptor!.get!.call(scroller) as number;
          if (!scrollJumpCaptured && before - after > 100) {
            scrollJumpCaptured = true;
            frameGate.holdNext();
          }
        }
      });
      floating.click();
      scroller.scrollTop = scroller.scrollHeight;
      for (let attempt = 0; attempt < 100 && frameGate.pending() === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      delete (scroller as HTMLElement & { scrollTop?: number }).scrollTop;
      const lateAnimationFrame = frameGate.takeFrame();
      const lateAnimationFrames = lateAnimationFrame.count;
      frameGate.open();

      editor.setText(content, true);
      const target = editor.getText().indexOf('rafNew trailing prose 70');
      editor.revealSelection(target, target, { focusEditor: true, align: 'nearest' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const beforeLateRaf = editor.getTopVisiblePosition();
      lateAnimationFrame.run();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterLateRaf = editor.getTopVisiblePosition();
      return {
        scrollJumpCaptured,
        lateAnimationFrames,
        beforeLateRaf,
        afterLateRaf,
        placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
        footers: document.querySelectorAll('.meo-md-long-code-footer').length
      };
    }, replacementBlock('rafNew', 100));
    if (
      !lateRafReplacement.scrollJumpCaptured ||
      lateRafReplacement.lateAnimationFrames === 0 ||
      lateRafReplacement.placeholders !== 1 || lateRafReplacement.footers !== 0 ||
      Math.abs(lateRafReplacement.afterLateRaf.line - lateRafReplacement.beforeLateRaf.line) > 1
    ) {
      throw new Error(`Late fold RAF changed the replacement Document: ${JSON.stringify(lateRafReplacement)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      delete (window as any).__longCodeBlocksEditor;
    });

    const languageLines = Array.from({ length: 19 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    const shortLines = Array.from({ length: 18 }, (_, index) => `const short${index + 1} = ${index + 1};`);
    const plainLines = Array.from({ length: 19 }, (_, index) => `plain ${index + 1}`);
    const mermaidLines = Array.from({ length: 19 }, (_, index) => `A${index}-->B${index}`);
    const text = [
      '```js',
      ...languageLines,
      '```',
      '',
      '```',
      ...plainLines,
      '```',
      '',
      '```mermaid',
      ...mermaidLines,
      '```',
      '',
      '```ts',
      ...shortLines,
      '```'
    ].join('\n');

    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await waitForFrames(page);

    const initial = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      expandText: document.querySelector('.meo-md-long-code-placeholder')?.textContent ?? '',
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      visibleCodeLines: document.querySelectorAll('.meo-md-code-line-numbered').length
    }));
    if (initial.placeholders !== 2) {
      throw new Error(`Expected language and plain-text long blocks to collapse, got ${JSON.stringify(initial)}`);
    }
    if (initial.expandText.replace(/\s+/g, ' ').trim() !== 'Show 9 more lines') {
      throw new Error(`Unexpected expand label: ${JSON.stringify(initial.expandText)}`);
    }
    const initialMetadata = await page.evaluate(() => ({
      labels: Array.from(document.querySelectorAll('.meo-long-code-language')).map((label) => label.textContent),
      lineCounts: Array.from(document.querySelectorAll('.meo-long-code-line-count')).map((label) => label.textContent),
      copyVisible: Boolean(document.querySelector('.meo-copy-code-btn'))
    }));
    if (
      initialMetadata.labels.length !== 0 || initialMetadata.lineCounts.length !== 0 ||
      !initialMetadata.copyVisible
    ) {
      throw new Error(`Collapsed code action retained redundant metadata: ${JSON.stringify(initialMetadata)}`);
    }
    await page.$eval('.meo-copy-code-btn', (button: HTMLElement) => button.click());
    await page.evaluate(() => Promise.resolve());
    const copiedLongCode = await page.evaluate(() => (window as any).__copiedLongCode as string | undefined);
    if (
      !copiedLongCode?.includes('const line1 = 1;') ||
      !copiedLongCode.includes('const line19 = 19;') ||
      copiedLongCode.includes('```')
    ) {
      throw new Error(`Collapsed copy did not include the complete code payload: ${JSON.stringify(copiedLongCode)}`);
    }
    const historyBeforeUiToggle = await page.evaluate(() => (
      (window as any).__longCodeBlocksEditor.getHistoryDepth()
    ));
    const actionUserSelect = await page.$eval(
      '.meo-md-long-code-placeholder .meo-long-code-action',
      (element) => getComputedStyle(element).userSelect
    );
    if (actionUserSelect !== 'none') {
      throw new Error(`Long code action text remains selectable: ${JSON.stringify(actionUserSelect)}`);
    }
    const actionBorderWidth = await page.$eval(
      '.meo-md-long-code-placeholder .meo-long-code-action',
      (element) => getComputedStyle(element).borderTopWidth
    );
    if (actionBorderWidth !== '0px') {
      throw new Error(`Fixed long code action retained an outer border: ${JSON.stringify(actionBorderWidth)}`);
    }
    if (initial.footerCount !== 0) {
      throw new Error(`Collapsed block unexpectedly has an expanded footer: ${JSON.stringify(initial)}`);
    }
    const initialVisibleText = await page.$eval('.cm-content', (element) => element.textContent ?? '');
    if (!initialVisibleText.includes('const line10 = 10;') || initialVisibleText.includes('const line11 = 11;')) {
      throw new Error('Collapsed block did not preserve exactly the first 10 code lines');
    }

    const placeholderWhitespace = await page.$eval('.meo-md-long-code-placeholder', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(placeholderWhitespace.x, placeholderWhitespace.y);
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 2) {
      throw new Error('Clicking placeholder whitespace unexpectedly expanded the code block');
    }

    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    const expanded = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      footerText: document.querySelector('.meo-md-long-code-footer')?.textContent ?? ''
    }));
    if (expanded.placeholders !== 1 || expanded.footerCount !== 1 || !expanded.footerText.includes('Show less')) {
      throw new Error(`Manual expansion failed: ${JSON.stringify(expanded)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.selectAll();
    });
    await waitForFrames(page);
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    const collapsedAgain = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      selectionEmpty: (window as any).__longCodeBlocksEditor.view.state.selection.main.empty,
      nativeSelectionText: window.getSelection()?.toString() ?? ''
    }));
    if (
      collapsedAgain.placeholders !== 2 ||
      collapsedAgain.footerCount !== 0 ||
      !collapsedAgain.selectionEmpty ||
      collapsedAgain.nativeSelectionText.includes('Show 9 more lines')
    ) {
      throw new Error(`Manual collapse failed: ${JSON.stringify(collapsedAgain)}`);
    }
    const historyAfterUiToggle = await page.evaluate(() => (
      (window as any).__longCodeBlocksEditor.getHistoryDepth()
    ));
    if (JSON.stringify(historyAfterUiToggle) !== JSON.stringify(historyBeforeUiToggle)) {
      throw new Error(`Long-code UI toggle entered Editor History: ${JSON.stringify({ historyBeforeUiToggle, historyAfterUiToggle })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const source = editor.view.state.doc.toString();
      const closing = source.lastIndexOf('```');
      editor.view.dispatch({ changes: { from: closing, insert: 'const short19 = 19;\n' } });
    });
    await waitForFrames(page, 12);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.view.scrollDOM.scrollTop = editor.view.scrollDOM.scrollHeight;
    });
    await waitForFrames(page);
    const grownShortBlock = await page.evaluate(() => ({
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (grownShortBlock.footers !== 1) {
      throw new Error(`Short-to-long block was auto-collapsed or missing footer: ${JSON.stringify(grownShortBlock)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    const originalBlock = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length
    }));
    if (originalBlock.placeholders !== 2) {
      throw new Error(`Original long block lost its collapsed state: ${JSON.stringify(originalBlock)}`);
    }

    const firstVisibleLine = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
        .find((element) => element.textContent?.includes('const line1 = 1;'));
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null;
    });
    if (!firstVisibleLine) {
      throw new Error('Could not locate a visible line in the collapsed code block');
    }
    await page.mouse.click(firstVisibleLine.x, firstVisibleLine.y);
    await waitForFrames(page);
    const clickExpanded = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (clickExpanded.placeholders !== 1 || clickExpanded.footers !== 1) {
      throw new Error(`Clicking visible code did not expand the block: ${JSON.stringify(clickExpanded)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const view = editor.view;
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        if (!line.text.includes('const line15 = 15;')) continue;
        view.dispatch({
          changes: { from: line.to, insert: ' HISTORY_TARGET' },
          selection: { anchor: line.to + ' HISTORY_TARGET'.length }
        });
        return;
      }
      throw new Error('Missing long-code history target');
    });
    await waitForFrames(page);
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    for (const direction of ['undo', 'redo'] as const) {
      await page.evaluate(async (historyDirection) => {
        const editor = (window as any).__longCodeBlocksEditor;
        const applied = historyDirection === 'undo' ? await editor.undo() : await editor.redo();
        if (!applied) throw new Error(`${historyDirection} was not applied`);
      }, direction);
      await waitForFrames(page, 10);
      const historyState = await page.evaluate((historyDirection) => {
        const editor = (window as any).__longCodeBlocksEditor;
        const view = editor.view;
        const head = view.state.selection.main.head;
        const selectedLine = view.state.doc.lineAt(head);
        const coords = view.coordsAtPos(head);
        const viewport = view.scrollDOM.getBoundingClientRect();
        return {
          direction: historyDirection,
          markerPresent: view.state.doc.toString().includes('HISTORY_TARGET'),
          selectedLine: selectedLine.text,
          targetVisible: Boolean(coords && coords.top >= viewport.top && coords.bottom <= viewport.bottom),
          placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length
        };
      }, direction);
      if (
        historyState.markerPresent !== (direction === 'redo') ||
        !historyState.selectedLine.includes('const line15 = 15;') ||
        !historyState.targetVisible ||
        historyState.placeholders !== 1
      ) {
        throw new Error(`History did not reveal its target inside a folded code block: ${JSON.stringify(historyState)}`);
      }
    }
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);

    const searchBlock = (name: string) => [
      '```js',
      ...Array.from({ length: 24 }, (_, index) => (
        index === 14 ? `const needle = '${name}';` : `const ${name}${index + 1} = ${index + 1};`
      )),
      '```'
    ];
    const searchText = [
      ...searchBlock('first'),
      '',
      ...Array.from({ length: 8 }, (_, index) => `between ${index + 1}`),
      '',
      ...searchBlock('second')
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, searchText);
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.setSearchQuery('needle');
      editor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    if (!await page.$eval('.meo-md-long-code-footer', (element) => element.textContent?.includes('Show less') ?? false)) {
      throw new Error('Search did not temporarily expand the first matching code block');
    }

    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.setSearchQuery('');
    });
    await waitForFrames(page);
    for (const lineNumber of [1, 37]) {
      await page.evaluate((line) => {
        (window as any).__longCodeBlocksEditor.scrollToLine(line, 'center');
      }, lineNumber);
      await waitForFrames(page);
      if (!await page.$('.meo-md-long-code-placeholder')) {
        throw new Error(`Ending search did not restore the collapsed block at line ${lineNumber}`);
      }
    }
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.setSearchQuery('needle');
      editor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Moving search to another block did not collapse the previous temporary expansion');
    }

    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.findPrevious('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    const searchMatchLine = await page.evaluate(() => {
      const match = document.querySelector('.meo-search-match-active');
      const rect = match?.getBoundingClientRect();
      return rect ? { x: rect.left + 2, y: rect.top + rect.height / 2 } : null;
    });
    if (!searchMatchLine) {
      throw new Error('Could not locate the active search match inside the expanded block');
    }
    await page.mouse.click(searchMatchLine.x, searchMatchLine.y);
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Moving search after clicking a temporary target overwrote the manual collapsed state');
    }

    const unusualText = [
      '```brainfuck',
      ...Array.from({ length: 19 }, (_, index) => `unknown ${index + 1}`),
      '```',
      '',
      '~~~mystery',
      ...Array.from({ length: 19 }, (_, index) => `incomplete ${index + 1}`)
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, unusualText);
    await waitForFrames(page, 10);
    const unusualLive = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      labels: Array.from(document.querySelectorAll('.meo-long-code-language')).map((label) => label.textContent),
      visibleText: document.querySelector('.cm-content')?.textContent ?? '',
      documentText: (window as any).__longCodeBlocksEditor.view.state.doc.toString()
    }));
    if (
      unusualLive.placeholders !== 2 || unusualLive.labels.length !== 0 ||
      unusualLive.visibleText.includes('unknown 11') ||
      unusualLive.visibleText.includes('incomplete 11') || unusualLive.documentText !== unusualText
    ) {
      throw new Error(`Unknown or incomplete fenced code was not safely folded: ${JSON.stringify(unusualLive)}`);
    }
    const targetDepth = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('unknown 15');
      const before = editor.getHistoryDepth();
      editor.view.dispatch({ selection: { anchor: position } });
      return { before, after: editor.getHistoryDepth() };
    });
    await waitForFrames(page);
    if (
      await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1 ||
      JSON.stringify(targetDepth.before) !== JSON.stringify(targetDepth.after)
    ) {
      throw new Error(`Cursor target did not temporarily reveal hidden code without history: ${JSON.stringify(targetDepth)}`);
    }
    const revealedTarget = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('unknown 15'));
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 24, y: rect.top + rect.height / 2 } : null;
    });
    if (!revealedTarget) throw new Error('Could not click the temporarily revealed long-code target');
    await page.mouse.click(revealedTarget.x, revealedTarget.y);
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.dispatch({ selection: { anchor: 0 } });
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Clicking temporarily revealed code did not promote the block to user-kept expansion');
    }
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('unknown 15');
      editor.view.dispatch({ selection: { anchor: position } });
      editor.view.focus();
    });
    await waitForFrames(page);
    await page.keyboard.type('X');
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.dispatch({ selection: { anchor: 0 } });
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Editing temporarily revealed code did not promote the block to user-kept expansion');
    }
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    const crossBoundaryDepth = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const hidden = editor.view.state.doc.toString().indexOf('unknown 15');
      const before = editor.getHistoryDepth();
      editor.view.dispatch({ selection: { anchor: 0, head: hidden } });
      return { before, after: editor.getHistoryDepth() };
    });
    await waitForFrames(page);
    if (
      await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1 ||
      JSON.stringify(crossBoundaryDepth.before) !== JSON.stringify(crossBoundaryDepth.after)
    ) {
      throw new Error(`Cross-boundary selection did not reveal its hidden endpoint: ${JSON.stringify(crossBoundaryDepth)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.dispatch({ selection: { anchor: 0 } });
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 2) {
      throw new Error('Cross-boundary selection end did not restore the manual collapsed state');
    }
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const hidden = editor.view.state.doc.toString().indexOf('unknown 15');
      editor.view.dispatch({ selection: { anchor: hidden } });
      editor.view.dispatch({ selection: { anchor: 0 } });
      editor.setSearchQuery('unknown 15');
      editor.findNext('unknown 15', { focusEditor: false });
      editor.setSearchQuery('');
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Cursor/search temporary visibility overwrote a manual expanded state');
    }
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 2) {
      throw new Error('Manual collapse did not remain authoritative after temporary targets ended');
    }
    await page.evaluate(() => (window as any).__longCodeBlocksEditor.setMode('source'));
    await waitForFrames(page, 10);
    const sourceState = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      visibleText: document.querySelector('.cm-content')?.textContent ?? ''
    }));
    if (
      sourceState.placeholders !== 0 || !sourceState.visibleText.includes('unknown 19') ||
      !sourceState.visibleText.includes('incomplete 19')
    ) {
      throw new Error(`Source did not show complete fenced code: ${JSON.stringify(sourceState)}`);
    }
    await page.evaluate(() => (window as any).__longCodeBlocksEditor.setMode('live'));
    await waitForFrames(page, 10);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 2) {
      throw new Error('Returning to a Live session did not restore default compact code presentation');
    }

    const tallText = [
      '```js',
      ...Array.from({ length: 100 }, (_, index) => (
        `const tall${index + 1} = '${'x'.repeat((index % 7) * 9)}';`
      )),
      '```',
      '',
      ...Array.from({ length: 40 }, (_, index) => `after block ${index + 1}`)
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, tallText);
    await waitForFrames(page);
    const tallFirstLine = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
        .find((element) => element.textContent?.includes('const tall1 ='));
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null;
    });
    if (!tallFirstLine) {
      throw new Error('Could not locate the tall code block');
    }
    const fixedControlCenter = await page.$eval('.meo-md-long-code-placeholder .meo-long-code-action', (element) => {
      const rect = element.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    await page.mouse.click(tallFirstLine.x, tallFirstLine.y);
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall5');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = Math.max(0, block.top - 20);
    });
    await waitForFrames(page);
    const visibleCollapseScrollTop = await page.$eval('.cm-scroller', (element) => element.scrollTop);
    await page.click('.meo-long-code-floating-action');
    await waitForFrames(page);
    const preservedScrollTop = await page.$eval('.cm-scroller', (element) => element.scrollTop);
    if (Math.abs(preservedScrollTop - visibleCollapseScrollTop) > 1) {
      throw new Error(`Collapsing a still-visible block changed the scroll position: ${JSON.stringify({ visibleCollapseScrollTop, preservedScrollTop })}`);
    }
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall100');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight + 80;
    });
    await waitForFrames(page);
    const fixedFooterState = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const footer = document.querySelector('.meo-md-long-code-footer')?.getBoundingClientRect();
      const floating = document.querySelector<HTMLButtonElement>('.meo-long-code-floating-action');
      return {
        footerVisible: Boolean(footer && footer.bottom >= scroller.top && footer.top <= scroller.bottom),
        floatingVisible: Boolean(floating && !floating.hidden)
      };
    });
    if (!fixedFooterState.footerVisible || fixedFooterState.floatingVisible) {
      throw new Error(`Floating button overlapped the visible fixed footer: ${JSON.stringify(fixedFooterState)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall50');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight / 2;
    });
    await waitForFrames(page);
    const floatingInsideBlock = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => !button.hidden);
    if (!floatingInsideBlock) {
      throw new Error('Floating collapse button was not shown while viewport bottom was inside an expanded block');
    }
    const floatingHorizontalCenters = await page.evaluate(async () => {
      const editor = (window as any).__longCodeBlocksEditor;
      const readCenter = () => {
        const floating = document.querySelector<HTMLElement>('.meo-long-code-floating-action')!;
        const rect = floating.getBoundingClientRect();
        return rect.left + rect.width / 2;
      };
      const samples = [readCenter()];
      editor.view.scrollDOM.scrollTop += 32;
      samples.push(readCenter());
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(readCenter());
      }
      return samples;
    });
    if (floatingHorizontalCenters.some((center) => Math.abs(center - fixedControlCenter) > 1)) {
      throw new Error(`Floating collapse button moved horizontally while settling after scroll: ${JSON.stringify({ fixedControlCenter, floatingHorizontalCenters })}`);
    }
    const floatingBackground = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => {
      const style = getComputedStyle(button);
      const color = style.backgroundColor;
      const alphaMatch = /rgba?\([^)]*(?:,|\/)\s*([\d.]+)\s*\)$/.exec(color);
      return { color, image: style.backgroundImage, alpha: color === 'transparent' ? 0 : Number(alphaMatch?.[1] ?? 1) };
    });
    if (floatingBackground.alpha < 1) {
      throw new Error(`Floating collapse button background was translucent: ${JSON.stringify(floatingBackground)}`);
    }
    await page.hover('.meo-long-code-floating-action');
    const floatingHoverBackground = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => {
      const style = getComputedStyle(button);
      return { color: style.backgroundColor, image: style.backgroundImage };
    });
    await page.mouse.down();
    const floatingActiveBackground = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => getComputedStyle(button).backgroundColor);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    if ((floatingHoverBackground.color === floatingBackground.color && floatingHoverBackground.image === floatingBackground.image) ||
        floatingHoverBackground.color === 'transparent' || floatingHoverBackground.color.startsWith('rgba(0, 0, 0, 0') ||
        floatingActiveBackground === 'transparent' || floatingActiveBackground.startsWith('rgba(0, 0, 0, 0')) {
      throw new Error(`Floating collapse button became transparent during interaction: ${JSON.stringify({ floatingHoverBackground, floatingActiveBackground })}`);
    }
    const floatingHorizontalOffset = await page.evaluate(() => {
      const floating = document.querySelector('.meo-long-code-floating-action')!.getBoundingClientRect();
      return floating.left + floating.width / 2;
    }).then((floatingCenter) => Math.abs(floatingCenter - fixedControlCenter));
    if (floatingHorizontalOffset > 1) {
      throw new Error(`Floating collapse button was not centered over the code content: ${floatingHorizontalOffset}`);
    }
    await page.click('.meo-long-code-floating-action');
    await waitForFrames(page);
    const collapsedBlockVisible = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const candidates = [
        ...Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
          .filter((element) => element.textContent?.includes('const tall')),
        document.querySelector('.meo-md-long-code-placeholder')
      ].filter((element): element is Element => Boolean(element));
      return candidates.some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= scroller.top && rect.top <= scroller.bottom;
      });
    });
    if (!collapsedBlockVisible) {
      throw new Error('Collapsing from a deep scroll left the entire code block outside the viewport');
    }
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('after block 20');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight / 2;
    });
    await waitForFrames(page);
    const floatingInProse = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => !button.hidden);
    if (floatingInProse) {
      throw new Error('Floating collapse button remained visible when viewport bottom moved into prose');
    }

    const nestedLongLines = Array.from({ length: 80 }, (_, index) => `  const nested${index + 1} = ${index + 1};`);
    const nestedText = [
      '```js',
      'const top = true;',
      '```',
      '',
      '- nested code',
      '',
      '  ```js',
      ...nestedLongLines,
      '  ```'
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, nestedText);
    await waitForFrames(page);

    const collapsedNestedLayout = await page.evaluate(() => {
      const starts = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-code-block-start'));
      const placeholder = document.querySelector<HTMLElement>('.meo-md-long-code-placeholder');
      const top = starts[0]?.getBoundingClientRect();
      const nested = starts[1]?.getBoundingClientRect();
      const control = placeholder?.getBoundingClientRect();
      return {
        topLeft: top?.left ?? 0,
        nestedLeft: nested?.left ?? 0,
        nestedCenter: nested ? nested.left + nested.width / 2 : 0,
        controlCenter: control ? control.left + control.width / 2 : 0
      };
    });
    if (
      collapsedNestedLayout.nestedLeft <= collapsedNestedLayout.topLeft ||
      Math.abs(collapsedNestedLayout.controlCenter - collapsedNestedLayout.nestedCenter) > 1
    ) {
      throw new Error(`Nested collapsed code layout lost its indentation: ${JSON.stringify(collapsedNestedLayout)}`);
    }

    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    const expandedNestedLayout = await page.evaluate(() => {
      const nested = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-code-block-start'))[1]?.getBoundingClientRect();
      const footer = document.querySelector<HTMLElement>('.meo-md-long-code-footer')?.getBoundingClientRect();
      return {
        nestedCenter: nested ? nested.left + nested.width / 2 : 0,
        footerCenter: footer ? footer.left + footer.width / 2 : 0
      };
    });
    if (Math.abs(expandedNestedLayout.footerCenter - expandedNestedLayout.nestedCenter) > 1) {
      throw new Error(`Nested fixed Show less was not centered over its code block: ${JSON.stringify(expandedNestedLayout)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const nested40');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight / 2;
    });
    await waitForFrames(page);
    const floatingNestedLayout = await page.evaluate(() => {
      const floating = document.querySelector<HTMLButtonElement>('.meo-long-code-floating-action');
      const floatingRect = floating?.getBoundingClientRect();
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const probeY = scroller.bottom - 8;
      const visibleLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-code-block'))
        .map((line) => line.getBoundingClientRect())
        .find((rect) => rect.top <= probeY && rect.bottom >= probeY);
      return {
        visible: Boolean(floating && !floating.hidden),
        lineCenter: visibleLine ? visibleLine.left + visibleLine.width / 2 : 0,
        floatingCenter: floatingRect ? floatingRect.left + floatingRect.width / 2 : 0
      };
    });
    if (
      !floatingNestedLayout.visible ||
      Math.abs(floatingNestedLayout.floatingCenter - floatingNestedLayout.lineCenter) > 1
    ) {
      throw new Error(`Nested floating Show less was not centered over its code block: ${JSON.stringify(floatingNestedLayout)}`);
    }

    const nestedRenderedBlocksText = [
      '```js',
      'const top = true;',
      '```',
      '',
      '- nested blocks',
      '',
      '  ```mermaid',
      '  graph TD',
      '  A-->B',
      '  ```',
      '',
      '  $$',
      '  x^2',
      '  $$'
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, nestedRenderedBlocksText);
    await waitForFrames(page, 12);

    const mermaidShellLayout = await page.evaluate(() => {
      const diagram = document.querySelector<HTMLElement>('.meo-mermaid-block');
      if (!diagram) return null;
      const shell = diagram.closest<HTMLElement>(
        '.meo-rendered-block-preview[data-meo-rendered-block-kind="mermaid"]'
      );
      const language = shell?.querySelector<HTMLElement>('.meo-rendered-block-preview-language');
      const toolbar = shell?.querySelector<HTMLElement>(':scope > .meo-mermaid-toolbar');
      const diagramRect = diagram.getBoundingClientRect();
      const shellRect = shell?.getBoundingClientRect();
      let next = shell?.nextElementSibling as HTMLElement | null;
      let detachedClosingFence = false;
      while (next && !next.classList.contains('meo-md-code-block-start')) {
        if (next.classList.contains('meo-md-code-block-end')) detachedClosingFence = true;
        next = next.nextElementSibling as HTMLElement | null;
      }
      return {
        atomicShell: Boolean(shell && language && toolbar && shell.contains(diagram)),
        topGap: shellRect ? diagramRect.top - shellRect.top : null,
        bottomGap: shellRect ? shellRect.bottom - diagramRect.bottom : null,
        shellRadius: shell ? getComputedStyle(shell).borderRadius : null,
        diagramRadius: getComputedStyle(diagram).borderRadius,
        detachedClosingFence
      };
    });
    if (
      !mermaidShellLayout?.atomicShell ||
      mermaidShellLayout.topGap === null ||
      mermaidShellLayout.bottomGap === null ||
      Math.abs(mermaidShellLayout.topGap) > 1 ||
      Math.abs(mermaidShellLayout.bottomGap) > 1 ||
      mermaidShellLayout.shellRadius !== '6px' ||
      mermaidShellLayout.diagramRadius !== '6px' ||
      mermaidShellLayout.detachedClosingFence
    ) {
      throw new Error(`Mermaid preview shell is visually disconnected: ${JSON.stringify(mermaidShellLayout)}`);
    }

    const renderedBlockLayout = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>('.cm-line.meo-md-code-block-start')?.getBoundingClientRect();
      const mermaid = document.querySelector<HTMLElement>('.meo-mermaid-block')?.getBoundingClientRect();
      const math = document.querySelector<HTMLElement>('.meo-md-math-fenced-display')?.getBoundingClientRect();
      return {
        topLeft: top?.left ?? 0,
        topRight: top?.right ?? 0,
        mermaidLeft: mermaid?.left ?? 0,
        mermaidRight: mermaid?.right ?? 0,
        mathLeft: math?.left ?? 0,
        mathRight: math?.right ?? 0
      };
    });
    if (
      renderedBlockLayout.mermaidLeft <= renderedBlockLayout.topLeft ||
      renderedBlockLayout.mathLeft <= renderedBlockLayout.topLeft ||
      Math.abs(renderedBlockLayout.mermaidRight - renderedBlockLayout.topRight) > 1 ||
      Math.abs(renderedBlockLayout.mathRight - renderedBlockLayout.topRight) > 1
    ) {
      throw new Error(`Nested Mermaid or math block lost its indentation: ${JSON.stringify(renderedBlockLayout)}`);
    }

    await page.click('.meo-mermaid-mode-btn');
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page, 12);
    const editingBlockLayout = await page.evaluate(() => {
      const top = document.querySelector<HTMLElement>('.cm-line.meo-md-code-block-start')?.getBoundingClientRect();
      const mermaid = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')?.getBoundingClientRect();
      const math = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')?.getBoundingClientRect();
      return {
        topLeft: top?.left ?? 0,
        topRight: top?.right ?? 0,
        mermaidLeft: mermaid?.left ?? 0,
        mermaidRight: mermaid?.right ?? 0,
        mathLeft: math?.left ?? 0,
        mathRight: math?.right ?? 0
      };
    });
    if (
      editingBlockLayout.mermaidLeft <= editingBlockLayout.topLeft ||
      editingBlockLayout.mathLeft <= editingBlockLayout.topLeft ||
      Math.abs(editingBlockLayout.mermaidRight - editingBlockLayout.topRight) > 1 ||
      Math.abs(editingBlockLayout.mathRight - editingBlockLayout.topRight) > 1
    ) {
      throw new Error(`Nested Mermaid or math editing block lost its indentation: ${JSON.stringify(editingBlockLayout)}`);
    }

    await page.setViewport({ width: 720, height: 600, deviceScaleFactor: 1 });
    const fullyVisibleFoldText = [
      ...Array.from({ length: 76 }, (_, index) => `prelude ${index + 1}`),
      '```text',
      ...Array.from({ length: 20 }, (_, index) => `row ${index + 1}`),
      '```',
      ...Array.from({ length: 20 }, (_, index) => `tail ${index + 1}`)
    ].join('\n');
    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__longCodeBlocksEditor.scrollToLine(77, 'center');
    }, fullyVisibleFoldText);
    await waitForFrames(page, 10);
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(
        editor.view.state.doc.line(77).from
      ).top - 24);
    });
    await waitForFrames(page, 10);
    const preparedFullyVisibleFold = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const opening = document.querySelector<HTMLElement>('.cm-line.meo-md-code-block-start');
      const footer = document.querySelector<HTMLElement>('.meo-md-long-code-footer');
      if (!opening || !footer) throw new Error('Missing expanded fully-visible fold fixture');
      const scroller = editor.view.scrollDOM;
      const scrollerRect = scroller.getBoundingClientRect();
      const openingRect = opening.getBoundingClientRect();
      scroller.scrollTop += openingRect.top - scrollerRect.top - 24;
      const selection = editor.view.state.doc.line(76).from;
      editor.view.dispatch({ selection: { anchor: selection } });
      editor.view.focus();
      const nextOpeningRect = opening.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const nextScrollerRect = scroller.getBoundingClientRect();
      return {
        blockTop: nextOpeningRect.top,
        blockBottom: footerRect.bottom,
        viewportTop: nextScrollerRect.top,
        viewportBottom: nextScrollerRect.bottom,
        selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number
      };
    });
    if (
      preparedFullyVisibleFold.blockTop < preparedFullyVisibleFold.viewportTop - 1 ||
      preparedFullyVisibleFold.blockBottom > preparedFullyVisibleFold.viewportBottom + 1 ||
      preparedFullyVisibleFold.selectionLine !== 76
    ) {
      throw new Error(`Could not place the complete code block in the viewport: ${JSON.stringify(preparedFullyVisibleFold)}`);
    }

    const collapsePoint = await page.$eval(
      '.meo-md-long-code-footer .meo-long-code-action',
      (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.evaluate(() => {
      const scroller = (window as any).__longCodeBlocksEditor.view.scrollDOM as HTMLElement;
      let owner: object | null = scroller;
      let descriptor: PropertyDescriptor | undefined;
      while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, 'scrollTop');
        owner = Object.getPrototypeOf(owner);
      }
      if (!descriptor?.get || !descriptor.set) throw new Error('Browser scrollTop boundary is unavailable');
      const redundantWrites: number[] = [];
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => descriptor!.get!.call(scroller),
        set: (value: number) => {
          const before = descriptor!.get!.call(scroller) as number;
          descriptor!.set!.call(scroller, value);
          const after = descriptor!.get!.call(scroller) as number;
          if (Math.abs(before - after) <= 0.1) redundantWrites.push(value);
        }
      });
      (window as any).__fullyVisibleFoldScrollWriteProbe = {
        redundantWrites,
        stop() { delete (scroller as HTMLElement & { scrollTop?: number }).scrollTop; }
      };
    });
    await page.mouse.move(collapsePoint.x, collapsePoint.y);
    await page.mouse.down();
    const pointerDownFocus = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      return {
        editorFocused: editor.view.hasFocus,
        actionFocused: document.activeElement?.classList.contains('meo-long-code-action') ?? false
      };
    });
    await page.mouse.up();
    const collapsedFullyVisibleFold = await page.evaluate(async () => {
      const editor = (window as any).__longCodeBlocksEditor;
      const opening = document.querySelector<HTMLElement>('.cm-line.meo-md-code-block-start');
      const samples: Array<{ scrollTop: number; openingTop: number }> = [];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          openingTop: opening?.getBoundingClientRect().top ?? Number.NaN
        });
      }
      const scrollWriteProbe = (window as any).__fullyVisibleFoldScrollWriteProbe;
      scrollWriteProbe.stop();
      return {
        samples,
        redundantScrollWrites: scrollWriteProbe.redundantWrites.length,
        selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        editorFocused: editor.view.hasFocus,
        placeholderCount: document.querySelectorAll('.meo-md-long-code-placeholder').length
      };
    });
    const collapseScrolls = collapsedFullyVisibleFold.samples.map((sample) => sample.scrollTop);
    const collapseTops = collapsedFullyVisibleFold.samples.map((sample) => sample.openingTop);
    if (
      !pointerDownFocus.editorFocused || pointerDownFocus.actionFocused ||
      collapsedFullyVisibleFold.selectionLine !== 76 ||
      !collapsedFullyVisibleFold.editorFocused || collapsedFullyVisibleFold.placeholderCount !== 1 ||
      collapsedFullyVisibleFold.redundantScrollWrites !== 0 ||
      Math.max(...collapseScrolls) - Math.min(...collapseScrolls) > 1 ||
      Math.max(...collapseTops) - Math.min(...collapseTops) > 1
    ) {
      throw new Error(`Fully-visible collapse changed focus, selection, or viewport: ${JSON.stringify({ pointerDownFocus, collapsedFullyVisibleFold })}`);
    }

    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page, 8);
    const expandedFullyVisibleFold = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      return {
        selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        editorFocused: editor.view.hasFocus,
        footerCount: document.querySelectorAll('.meo-md-long-code-footer').length
      };
    });
    if (
      expandedFullyVisibleFold.selectionLine !== 76 ||
      !expandedFullyVisibleFold.editorFocused || expandedFullyVisibleFold.footerCount !== 1
    ) {
      throw new Error(`Fully-visible expansion changed focus or selection: ${JSON.stringify(expandedFullyVisibleFold)}`);
    }

    await page.evaluate(() => {
      const samples: Array<{ contentVisible: boolean; gutterVisible: boolean }> = [];
      let running = true;
      const sample = () => {
        const visibleLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .filter((line) => line.getBoundingClientRect().height > 0)
          .map((line) => line.textContent);
        const contentVisible = ['prelude 76', 'row 1'].every((text) => visibleLines.includes(text));
        const visibleGutters = Array.from(
          document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
        ).filter((marker) => marker.getBoundingClientRect().height > 0)
          .map((marker) => marker.textContent?.trim());
        const gutterVisible = ['76', '78'].every((lineNumber) => visibleGutters.includes(lineNumber));
        samples.push({ contentVisible, gutterVisible });
        if (running) requestAnimationFrame(sample);
      };
      (window as any).__fullyVisibleFoldFrameProbe = {
        samples,
        stop() { running = false; }
      };
      requestAnimationFrame(sample);
    });
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await page.click('.meo-md-long-code-footer .meo-long-code-action');
      await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    }
    await waitForFrames(page, 8);
    const fullyVisibleFoldFrameProbe = await page.evaluate(() => {
      const probe = (window as any).__fullyVisibleFoldFrameProbe;
      probe.stop();
      return probe.samples as Array<{ contentVisible: boolean; gutterVisible: boolean }>;
    });
    const missingContentFrames = fullyVisibleFoldFrameProbe.filter((sample) => !sample.contentVisible).length;
    const missingGutterFrames = fullyVisibleFoldFrameProbe.filter((sample) => !sample.gutterVisible).length;
    if (missingContentFrames > 0 || missingGutterFrames > 0) {
      throw new Error(`Fully-visible fold flashed during repeated toggles: ${JSON.stringify({
        totalFrames: fullyVisibleFoldFrameProbe.length,
        missingContentFrames,
        missingGutterFrames
      })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const hiddenSelection = editor.view.state.doc.toString().indexOf('row 15');
      editor.view.dispatch({ selection: { anchor: hiddenSelection } });
      editor.view.focus();
    });
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page, 8);
    const hiddenSelectionCollapse = await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      return {
        selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        selectionEmpty: editor.view.state.selection.main.empty,
        placeholderCount: document.querySelectorAll('.meo-md-long-code-placeholder').length
      };
    });
    if (
      hiddenSelectionCollapse.selectionLine !== 87 ||
      !hiddenSelectionCollapse.selectionEmpty || hiddenSelectionCollapse.placeholderCount !== 1
    ) {
      throw new Error(`Collapsing a hidden selection did not move it to the last visible code line: ${JSON.stringify(hiddenSelectionCollapse)}`);
    }

    console.log('long code block checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
