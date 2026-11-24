import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import assert from 'node:assert/strict';
import { createTextSearch } from '../webview/src/application/searchCaseFolding';

for (const locale of ['en', 'tr']) {
  const next = createTextSearch('istanbul', false, locale)('İstanbul I\u0307stanbul');
  assert.deepEqual(next(), { start: 0, end: 8 });
  assert.deepEqual(next(), { start: 9, end: 18 });
  assert.equal(next(), null);
}
const lithuanianMatches = createTextSearch('cat', false, 'lt')('Ì cat I\u0301 cat');
assert.deepEqual(lithuanianMatches(), { start: 2, end: 5 });
assert.deepEqual(lithuanianMatches(), { start: 9, end: 12 });

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-search-replace-production-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
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
    await page.setViewport({ width: 980, height: 620, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body{margin:0} .test-host{height:520px}</style><div id="search" class="test-host"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const navigationText = Array.from({ length: 80 }, (_, index) => {
      if (index === 3 || index === 5 || index === 59) return `line ${index + 1} needle`;
      if (index === 69) return `line ${index + 1} solo`;
      return `line ${index + 1} ordinary`;
    }).join('\n');
    await page.evaluate((text) => {
      (window as any).__searchContractEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('search')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    }, navigationText);
    await waitForFrames(page);

    const visibleNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const scroller = editor.getScrollElement();
      const first = editor.findNext('needle', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterFirst = scroller.scrollTop;
      const second = editor.findNext('needle', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { first, second, afterFirst, afterSecond: scroller.scrollTop };
    });
    if (
      !visibleNavigation.first.found || !visibleNavigation.second.found ||
      Math.abs(visibleNavigation.afterSecond - visibleNavigation.afterFirst) > 1
    ) {
      throw new Error(`Visible search navigation moved the viewport: ${JSON.stringify(visibleNavigation)}`);
    }

    const outsideNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const result = editor.findNext('needle', { focusEditor: false });
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const selection = editor.view.state.selection.main;
      const activeRect = editor.view.coordsAtPos(selection.from);
      if (!activeRect) throw new Error('Outside search result has no public editor coordinates');
      const viewport = editor.getScrollElement().getBoundingClientRect();
      return {
        result,
        centerDelta: Math.abs(
          (activeRect.top + activeRect.bottom) / 2 - (viewport.top + viewport.bottom) / 2
        )
      };
    });
    if (!outsideNavigation.result.found || outsideNavigation.centerDelta > 24) {
      throw new Error(`Outside search result was not contextually centered: ${JSON.stringify(outsideNavigation)}`);
    }

    const replacementNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const wrapped = editor.replaceCurrent('needle', 'changed');
      editor.findNext('solo', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const selfContaining = editor.replaceCurrent('solo', 'solo-next');
      const selection = editor.view.state.selection.main;
      return {
        wrapped,
        selfContaining,
        selectionEmpty: selection.empty,
        precedingText: editor.getText().slice(selection.from - 'solo-next'.length, selection.from)
      };
    });
    if (
      !replacementNavigation.wrapped.replaced || !replacementNavigation.wrapped.found ||
      !replacementNavigation.selfContaining.replaced || replacementNavigation.selfContaining.found ||
      !replacementNavigation.selectionEmpty || replacementNavigation.precedingText !== 'solo-next'
    ) {
      throw new Error(`Single replacement continuation drifted: ${JSON.stringify(replacementNavigation)}`);
    }

    await page.evaluate(() => {
      (window as any).__searchContractEditor.destroy();
      document.getElementById('search')!.replaceChildren();
      const lines = Array.from({ length: 55 }, (_, index) => {
        if (index === 4 || index === 39) return `line ${index + 1} bulk`;
        if (index === 19) return '| A | B |';
        if (index === 20) return '| --- | --- |';
        if (index === 21) return '| bulk | value |';
        if (index === 22) return '| stable | row |';
        return `line ${index + 1} ordinary`;
      });
      const text = lines.join('\n');
      (window as any).__replaceAllOriginalText = text;
      (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('search')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page, 10);
    await page.waitForSelector('tbody td:first-child > [data-table-resize-column="0"]');
    const bodyHandleCount = await page.$$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody td > [data-table-resize-column]',
      (handles) => handles.length
    );
    const widthBefore = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child',
      (cell) => cell.getBoundingClientRect().width
    );
    await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody td:first-child > [data-table-resize-column="0"]',
      (handle) => {
        const rect = handle.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, buttons: 1, pointerId: 731, pointerType: 'mouse', clientX, clientY
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, buttons: 1, pointerId: 731, pointerType: 'mouse', clientX: clientX + 48, clientY
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, button: 0, buttons: 0, pointerId: 731, pointerType: 'mouse', clientX: clientX + 48, clientY
        }));
      }
    );
    await waitForFrames(page);
    const resizedWidth = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child',
      (cell) => cell.getBoundingClientRect().width
    );

    const replaceAllState = await page.evaluate(async () => {
      const editor = (window as any).__replaceAllEditor;
      const selectionPosition = editor.view.state.doc.line(35).from + 4;
      editor.revealSelection(selectionPosition, selectionPosition, { focusEditor: false, align: 'center' });
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const beforeTopLine = editor.getTopVisiblePosition().line;
      const beforeHistory = editor.getHistoryDepth();
      const result = editor.replaceAll('bulk', 'done');
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const selectionLine = editor.view.state.doc.lineAt(editor.view.state.selection.main.anchor).number;
      const afterTopLine = editor.getTopVisiblePosition().line;
      const afterHistory = editor.getHistoryDepth();
      const width = document.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child'
      )!.getBoundingClientRect().width;
      const undoApplied = await editor.undo();
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const restored = editor.getText() === (window as any).__replaceAllOriginalText;
      const redoApplied = await editor.redo();
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return {
        result,
        beforeTopLine,
        afterTopLine,
        selectionLine,
        beforeHistory,
        afterHistory,
        width,
        undoApplied,
        restored,
        redoApplied,
        redone: !editor.getText().includes('bulk') && editor.getText().split('done').length - 1 === 3
      };
    });
    if (
      bodyHandleCount !== 4 || resizedWidth < widthBefore + 30 ||
      replaceAllState.result.replaced !== 3 || replaceAllState.selectionLine !== 35 ||
      Math.abs(replaceAllState.afterTopLine - replaceAllState.beforeTopLine) > 1 ||
      replaceAllState.afterHistory.undo !== replaceAllState.beforeHistory.undo + 1 ||
      Math.abs(replaceAllState.width - resizedWidth) > 2 ||
      !replaceAllState.undoApplied || !replaceAllState.restored ||
      !replaceAllState.redoApplied || !replaceAllState.redone
    ) {
      throw new Error(`Replace-all or table-width contract failed: ${JSON.stringify({
        bodyHandleCount,
        widthBefore,
        resizedWidth,
        replaceAllState
      })}`);
    }

    const repeatedText = Array.from({ length: 130 }, (_, index) =>
      [9, 100, 120].includes(index) ? 'bulk' : 'repeated unchanged line'
    ).join('\n');
    for (const mode of ['source', 'live']) {
      for (const replacement of ['done', 'first row\nsecond row']) {
        await page.evaluate(({text, mode}) => {
          (window as any).__replaceAllEditor.destroy();
          document.getElementById('search')!.replaceChildren();
          (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
            parent: document.getElementById('search')!, text, initialMode: mode, onApplyChanges() {}
          });
        }, {text: repeatedText, mode});
        await waitForFrames(page, 8);
        const result = await page.evaluate(async replacement => {
          const editor = (window as any).__replaceAllEditor;
          const position = editor.view.state.doc.line(60).from;
          editor.revealSelection(position, position, {focusEditor: false, align: 'center'});
          await editor.whenVisiblePresentationReady(1_200);
          const before = editor.getTopVisiblePosition().line;
          const replaced = editor.replaceAll('bulk', replacement);
          await editor.whenVisiblePresentationReady(1_200);
          return {before, after: editor.getTopVisiblePosition().line, replaced,
            selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number};
        }, replacement);
        const upstreamLines = replacement.includes('\n') ? 1 : 0;
        if (result.replaced.replaced !== 3 || result.selectionLine !== 60 + upstreamLines
          || Math.abs(result.after - result.before - upstreamLines) > 1) {
          throw new Error('Disjoint replace-all moved a repeated reading anchor (' + mode + '): ' + JSON.stringify(result));
        }
      }
    }

    const richText = Array.from({ length: 80 }, (_, index) => [
      `# Section ${index}`, '', `paragraph bulk ${index}`, '',
      '| A | B |', '| --- | --- |', '| bulk | value |', '',
      '```mermaid', `flowchart LR; A[bulk ${index}] --> B[Finish]`, '```', '',
      '$$', `x_{${index}} = ${index}^2 + 1`, '$$', ''
    ].join('\n')).join('\n');
    for (const { mode, replacement } of ['source', 'live'].flatMap(mode => (
      ['done', 'a much longer label'].map(replacement => ({ mode, replacement }))
    ))) {
      await page.evaluate(({ text, mode }) => {
        (window as any).__replaceAllEditor.destroy();
        document.getElementById('search')!.replaceChildren();
        (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
          parent: document.getElementById('search')!, text, initialMode: mode, onApplyChanges() {}
        });
      }, { text: richText, mode });
      await waitForFrames(page, 10);
      const result = await page.evaluate(async (replacement) => {
        const editor = (window as any).__replaceAllEditor;
        const position = editor.view.state.doc.line(643).from;
        editor.revealSelection(position, position, { focusEditor: false, align: 'center' });
        await editor.whenVisiblePresentationReady(1_200);
        const before = editor.getTopVisiblePosition().line;
        const replaced = editor.replaceAll('bulk', replacement);
        await editor.whenVisiblePresentationReady(1_200);
        const after = editor.getTopVisiblePosition().line;
        const selectionLine = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
        return { before, after, replaced, selectionLine };
      }, replacement);
      if (result.replaced.replaced !== 240 || result.selectionLine !== 643 ||
        Math.abs(result.after - result.before) > 1) {
        throw new Error(`Rich-document replace-all lost reading position (${mode}): ${JSON.stringify(result)}`);
      }
    }

    // Lower-casing U+0130 adds a code unit, so folded offsets must stay in source coordinates.
    const filler = Array.from({ length: 9_000 }, (_, index) => `Paragraph ${index} with İ text.\n`).join('\n');
    for (const mode of ['source', 'live']) for (const large of [false, true]) {
      const suffix = large ? '\n' + filler : '';
      for (const { source, query, matches, replaced } of [
        { source: 'I\u0307stanbul has a cat here.', query: 'istanbul', matches: ['I\u0307stanbul'], replaced: 'dog has a cat here.' },
        { source: 'İstanbul has a cat here.', query: 'cat', matches: ['cat'], replaced: 'İstanbul has a dog here.' },
        { source: 'CAT İİ Cat and cat', query: 'cat', matches: ['CAT', 'Cat', 'cat'], replaced: 'dog İİ dog and dog' },
        { source: 'x İstanbul, İSTANBUL', query: 'İstanbul', matches: ['İstanbul', 'İSTANBUL'], replaced: 'x dog, dog' },
        { source: 'İ ΟΔΟΣ end', query: 'οδος', matches: ['ΟΔΟΣ'], replaced: 'İ dog end' },
        { source: 'İ 𐐀 Cat', query: '𐐨 cat', matches: ['𐐀 Cat'], replaced: 'İ dog' }
      ]) {
        const result = await page.evaluate(({ text, mode, query }) => {
          (window as any).__replaceAllEditor.destroy();
          document.getElementById('search')!.replaceChildren();
          const editor = (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
            parent: document.getElementById('search')!, text, initialMode: mode, onApplyChanges() {}
          });
          editor.setSearchQuery(query);
          const highlighted = [...editor.view.dom.querySelectorAll('.meo-search-match')].map(match => match.textContent);
          const total = editor.countMatches(query);
          const selected = Array.from({ length: total }, () => {
            editor.findNext(query, { focusEditor: false });
            const { from, to } = editor.view.state.selection.main;
            return editor.view.state.sliceDoc(from, to);
          });
          let error = '';
          try { editor.replaceAll(query, 'dog'); } catch (reason) { error = String(reason); }
          return { highlighted, selected: selected.sort(), error, text: editor.getText() };
        }, { text: source + suffix, mode, query });
        const label = JSON.stringify({ mode, large, source, query, ...result, text: result.text.slice(0, 80) });
        if (result.error || result.text !== replaced + suffix
          || JSON.stringify(result.highlighted) !== JSON.stringify(matches)
          || JSON.stringify(result.selected) !== JSON.stringify([...matches].sort())) {
          throw new Error(`Case-insensitive search left source coordinates: ${label}`);
        }
      }
    }
    await page.evaluate(() => {
      (window as any).__replaceAllEditor.destroy();
      document.getElementById('search')!.replaceChildren();
      (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('search')!, initialMode: 'live', onApplyChanges() {},
        text: 'intro\n\n| A | B |\n| --- | --- |\n| İ Cat end | x |\n'
      });
    });
    await waitForFrames(page);
    const tableMatches = await page.evaluate(() => {
      const editor = (window as any).__replaceAllEditor;
      editor.setSearchQuery('cat');
      return [...editor.view.dom.querySelectorAll('tbody td .meo-search-match')].map(match => match.textContent);
    });
    if (JSON.stringify(tableMatches) !== '["Cat"]') {
      throw new Error(`Table cell highlight left source coordinates: ${JSON.stringify(tableMatches)}`);
    }

    console.log('search and replace production contracts passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
