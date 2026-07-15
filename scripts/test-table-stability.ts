import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-stability-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) {
    throw new Error(build.logs.map(String).join('\n'));
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-semantic-tableBorder:#474b50; --meo-semantic-tableSelectionBorder:#79b8ff; --meo-semantic-unorderedListMarker:#79b8ff; --meo-semantic-orderedListMarker:#79b8ff; --meo-semantic-listGuide:#3e444d; --meo-semantic-searchMatchForeground:#202223; --meo-semantic-searchMatchBackground:#ffe600; --meo-semantic-searchMatchBorder:#ffe600; --meo-semantic-searchMatchActiveForeground:#202223; --meo-semantic-searchMatchActiveBackground:#ff8c00; --meo-semantic-searchMatchActiveBorder:#ff8c00; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const waitFrames = async (count = 3) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const create = async (text: string) => {
        app.replaceChildren();
        const editor = harness.createEditor({
          parent: app,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
        await waitFrames();
        return editor;
      };

      const editingEditor = await create('| A |\n| --- |\n| asd |');
      editingEditor.setSearchQuery('asd');
      editingEditor.findNext('asd', { focusEditor: false });
      await waitFrames();
      const editingInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      editingInput.focus();
      editingInput.value = 'asdx';
      editingInput.setSelectionRange(4, 4);
      editingInput.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFrames(1);
      const editingPreviewText = editingInput.parentElement?.querySelector('.meo-md-html-table-cell-preview')?.textContent ?? '';
      editingEditor.destroy();

      const inlineEditingEditor = await create('| A | B |\n| --- | --- |\n| before `literal` #tag [external](https://example.com) [internal](#target) **bold** | editing |');
      const inlineEditingInputs = document.querySelectorAll<HTMLTextAreaElement>('tbody textarea');
      const inlineEditingInput = inlineEditingInputs[0]!;
      const inlineEditingPreview = inlineEditingInput.parentElement!.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const inlineDecorationCount = inlineEditingPreview.querySelectorAll('code, .meo-md-tag, .meo-md-link, .meo-md-strong').length;
      const inlineLinkButtonElements = Array.from(inlineEditingPreview.querySelectorAll<HTMLButtonElement>('.meo-md-link-open-btn'));
      const inlineLinkButtons = inlineLinkButtonElements
        .map((button) => button.getAttribute('aria-label'));
      const inlineOpenedHrefs: string[] = [];
      const onInlineOpenLink = ((event: CustomEvent<{ href: string }>) => {
        inlineOpenedHrefs.push(event.detail.href);
      }) as EventListener;
      app.addEventListener('meo-open-link', onInlineOpenLink);
      inlineEditingInputs[1]!.focus();
      for (const button of inlineLinkButtonElements) {
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
        button.click();
      }
      app.removeEventListener('meo-open-link', onInlineOpenLink);
      const linkButtonsPreservedEditingCell = document.activeElement === inlineEditingInputs[1];
      inlineEditingInput.focus();
      inlineEditingInput.value = '11before `literal` #tag [external](https://example.com) [internal](#target) **bold**';
      inlineEditingInput.setSelectionRange(2, 2);
      inlineEditingInput.dispatchEvent(new Event('input', { bubbles: true }));
      const inlineEditingPreviewVisibility = getComputedStyle(inlineEditingPreview).visibility;
      inlineEditingEditor.destroy();

      const bodyLinkEditor = await create('intro\n\n[external](https://example.com) [internal](#target)');
      const bodyLinkButtonElements = Array.from(document.querySelectorAll<HTMLButtonElement>('.meo-md-link-open-btn'));
      const bodyLinkButtons = bodyLinkButtonElements.map((button) => button.getAttribute('aria-label'));
      const bodyOpenedHrefs: string[] = [];
      const onBodyOpenLink = ((event: CustomEvent<{ href: string }>) => {
        bodyOpenedHrefs.push(event.detail.href);
      }) as EventListener;
      app.addEventListener('meo-open-link', onBodyOpenLink);
      bodyLinkButtonElements.forEach((button) => button.click());
      app.removeEventListener('meo-open-link', onBodyOpenLink);
      bodyLinkEditor.destroy();

      const positionEditor = await create('| A |\n| --- |\n| value |');
      const lineBefore = document.querySelector('.meo-md-html-table-line-number')?.textContent ?? '';
      positionEditor.view.dispatch({ changes: { from: 0, insert: 'intro\n' } });
      await waitFrames();
      const lineAfter = document.querySelector('.meo-md-html-table-line-number')?.textContent ?? '';
      const regularLineNumber = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .find((item) => item.textContent?.trim() === '1');
      const tableLineNumber = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-line-number'))
        .find((item) => item.textContent?.trim() === '2');
      const textRight = (element: HTMLElement): number => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().right;
      };
      const lineNumberRightDelta = regularLineNumber && tableLineNumber
        ? textRight(tableLineNumber) - textRight(regularLineNumber)
        : null;
      const lineNumberNodeBeforeScroll = document.querySelector('.meo-md-html-table-line-number');
      positionEditor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      await waitFrames();
      const lineNumberNodeAfterScroll = document.querySelector('.meo-md-html-table-line-number');
      const lineNumberNodeReused = lineNumberNodeBeforeScroll === lineNumberNodeAfterScroll;
      positionEditor.destroy();

      const interactionEditor = await create('| A |\n| --- |\n| old |');
      const interactionInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      interactionInput.focus();
      interactionInput.value = 'new';
      interactionInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames();
      const interactionActive = interactionEditor.view.dom.classList.contains('meo-table-interaction-active');
      interactionEditor.destroy();

      const borderlessEditor = await create('A | B\n--- | ---\nasd | value');
      borderlessEditor.setSearchQuery('asd');
      borderlessEditor.findNext('asd', { focusEditor: false });
      await waitFrames();
      const borderlessActiveMatch = Boolean(document.querySelector('tbody .meo-search-match-active'));
      borderlessEditor.destroy();

      const alignmentEditor = await create('| A | B |\n| --- | --- |\n| one | two |');
      document.querySelector<HTMLTextAreaElement>('tbody textarea')!.focus();
      await waitFrames(1);
      document.querySelector<HTMLButtonElement>('button[title="Align selected column left"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const alignmentBeforeShift = document.querySelector<HTMLTableCellElement>('thead th')?.style.textAlign ?? '';
      alignmentEditor.view.dispatch({ changes: { from: 0, insert: 'intro\n' } });
      await waitFrames();
      const alignmentAfterShift = document.querySelector<HTMLTableCellElement>('thead th')?.style.textAlign ?? '';
      alignmentEditor.destroy();

      const listEditor = await create('| Items |\n| --- |\n| - first<br/>   3. nested<br />- second<br><br>tail `literal<br>code` |');
      const listPreview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const unorderedMarkerColor = getComputedStyle(listPreview.querySelector(':scope > ul > li')!, '::marker').color;
      const orderedListItem = listPreview.querySelector<HTMLElement>(':scope > ul > li > ol > li');
      const orderedMarkerColor = orderedListItem ? getComputedStyle(orderedListItem, '::marker').color : '';
      document.querySelector<HTMLTextAreaElement>('tbody textarea')!.focus();
      const renderedListState = {
        topLevelItems: listPreview.querySelectorAll(':scope > ul > li').length,
        nestedOrderedItems: listPreview.querySelectorAll(':scope > ul > li > ol > li').length,
        nestedOrderedStart: listPreview.querySelector<HTMLOListElement>(':scope > ul > li > ol')?.start ?? null,
        plainLines: listPreview.querySelectorAll(':scope > .meo-md-html-table-cell-line').length,
        inlineCodeText: listPreview.querySelector('code')?.textContent ?? '',
        text: listPreview.textContent ?? '',
        unorderedMarkerColor,
        orderedMarkerColor,
        editingPreviewVisibility: getComputedStyle(listPreview).visibility
      };
      listEditor.destroy();

      const nestedListEditor = await create('| Items |\n| --- |\n| - 一级 A  <br>- 二级<br>       A.1<br>           - 二级<br>       1. A.2<br>- 一级 B |');
      const nestedListPreview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const directListItemText = (item: HTMLElement) => {
        const textNode = Array.from(item.childNodes).find((node) => (
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
        ));
        if (!textNode) return null;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        return {
          text: textNode.textContent?.trim() ?? '',
          left: range.getBoundingClientRect().left,
          list: item.parentElement?.tagName.toLowerCase() ?? ''
        };
      };
      const nestedListIndentState = Array.from(nestedListPreview.querySelectorAll<HTMLElement>('li'))
        .map(directListItemText)
        .filter((item): item is NonNullable<typeof item> => item !== null);
      nestedListEditor.destroy();

      const whitespaceEditor = await create('| Items |\n| --- |\n| first<br>   indented |');
      const whitespaceLine = document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-line')[1]!;
      const whitespaceState = {
        text: whitespaceLine.textContent ?? '',
        whiteSpace: getComputedStyle(whitespaceLine).whiteSpace
      };
      whitespaceEditor.destroy();

      const shortcutEditor = await create('| Items |\n| --- |\n| - first |');
      const shortcutInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      shortcutInput.focus();
      shortcutInput.setSelectionRange(shortcutInput.value.length, shortcutInput.value.length);
      shortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      }));
      const continuedUnorderedValue = shortcutInput.value;
      shortcutInput.setRangeText('second', shortcutInput.selectionStart, shortcutInput.selectionEnd, 'end');
      shortcutInput.dispatchEvent(new Event('input', { bubbles: true }));
      shortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: ']',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      const indentedTableValue = shortcutInput.value;
      shortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: '[',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      shortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      const tableShortcutValue = shortcutInput.value;
      shortcutInput.setRangeText('third', shortcutInput.selectionStart, shortcutInput.selectionEnd, 'end');
      shortcutInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames();
      const tableShortcutSource = shortcutEditor.view.state.doc.toString();
      shortcutEditor.destroy();

      const navigationEditor = await create('| A | B |\n| --- | --- |\n| one | two |\n| three | four |');
      const firstNavigationInput = document.querySelector<HTMLTextAreaElement>('textarea[data-table-row="1"][data-table-col="1"]')!;
      firstNavigationInput.focus();
      firstNavigationInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      }));
      await waitFrames();
      const middleNavigationTarget = document.activeElement instanceof HTMLTextAreaElement
        ? { row: document.activeElement.dataset.tableRow, col: document.activeElement.dataset.tableCol }
        : null;
      (document.activeElement as HTMLTextAreaElement)?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      }));
      await waitFrames();
      const lastNavigationTarget = document.activeElement instanceof HTMLTextAreaElement
        ? { row: document.activeElement.dataset.tableRow, col: document.activeElement.dataset.tableCol }
        : null;
      const navigationSource = navigationEditor.view.state.doc.toString();
      navigationEditor.destroy();

      const dragSelectCells = (fromCell: HTMLElement, toCell: HTMLElement, pointerId: number) => {
        const table = fromCell.closest('table')!;
        const targetRect = toCell.getBoundingClientRect();
        fromCell.dispatchEvent(new PointerEvent('pointerdown', {
          button: 0,
          pointerId,
          bubbles: true,
          cancelable: true
        }));
        table.dispatchEvent(new PointerEvent('pointermove', {
          pointerId,
          clientX: targetRect.left + targetRect.width / 2,
          clientY: targetRect.top + targetRect.height / 2,
          bubbles: true,
          cancelable: true
        }));
        table.dispatchEvent(new PointerEvent('pointerup', {
          pointerId,
          bubbles: true,
          cancelable: true
        }));
      };

      const deleteRowsEditor = await create('| A | B |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |\n| r3a | r3b |');
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]')!,
        21
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const deleteRowsSource = deleteRowsEditor.view.state.doc.toString();
      deleteRowsEditor.destroy();

      const deleteColumnsEditor = await create('| A | B | C |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |');
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="1"]')!,
        22
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete column"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const deleteColumnsSource = deleteColumnsEditor.view.state.doc.toString();
      deleteColumnsEditor.destroy();

      const orderedShortcutEditor = await create('| Items |\n| --- |\n| 3. third |');
      const orderedShortcutInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      orderedShortcutInput.focus();
      orderedShortcutInput.setSelectionRange(orderedShortcutInput.value.length, orderedShortcutInput.value.length);
      orderedShortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      const continuedOrderedValue = orderedShortcutInput.value;
      orderedShortcutInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      const exitedEmptyOrderedItemValue = orderedShortcutInput.value;
      orderedShortcutEditor.destroy();

      const orderedIndentEditor = await create('| Items |\n| --- |\n| 3. first<br>4. second<br>5. third |');
      const orderedIndentInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      orderedIndentInput.focus();
      const orderedSecondItemEnd = orderedIndentInput.value.indexOf('4. second') + '4. second'.length;
      orderedIndentInput.setSelectionRange(orderedSecondItemEnd, orderedSecondItemEnd);
      orderedIndentInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: ']',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      const indentedOrderedValue = orderedIndentInput.value;
      orderedIndentInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: '[',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      const outdentedOrderedValue = orderedIndentInput.value;
      orderedIndentEditor.destroy();

      const pastedImageMessages: any[] = [];
      harness.initializeImageHandling({
        postMessage(message: any) {
          pastedImageMessages.push(message);
          if (message.type === 'saveImageFromClipboard') {
            queueMicrotask(() => harness.handleSavedImagePath({
              type: 'savedImagePath',
              requestId: message.requestId,
              success: true,
              path: 'images/pasted.png'
            }));
          }
        }
      });
      const tablePasteEditor = await create('| A | B |\n| --- | --- |\n| left | right |');
      const tablePasteInput = document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1]!;
      tablePasteInput.focus();
      tablePasteInput.setSelectionRange(2, 2);
      const imageBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
      const pasteEvent = {
        clipboardData: {
          items: [{ type: 'image/png', getAsFile: () => imageBlob }]
        },
        preventDefault() {},
        stopPropagation() {}
      } as unknown as ClipboardEvent;
      const tablePasteLine = tablePasteEditor.view.state.doc.lineAt(tablePasteEditor.view.state.selection.main.head);
      await harness.handleImagePaste(pasteEvent, tablePasteEditor, {
        lineNumber: tablePasteLine.number,
        lineOffset: tablePasteEditor.view.state.selection.main.head - tablePasteLine.from
      });
      await waitFrames();
      const tablePasteValue = tablePasteInput.value;
      const tablePasteSource = tablePasteEditor.view.state.doc.toString();
      tablePasteEditor.destroy();

      const bodyPasteEditor = await create('before after');
      bodyPasteEditor.view.dispatch({ selection: { anchor: 7 } });
      const bodyPasteLine = bodyPasteEditor.view.state.doc.lineAt(7);
      const fileOnlyPasteEvent = {
        clipboardData: {
          items: [],
          files: [imageBlob]
        },
        preventDefault() {},
        stopPropagation() {}
      } as unknown as ClipboardEvent;
      const bodyPasteHandled = await harness.handleImagePaste(fileOnlyPasteEvent, bodyPasteEditor, {
        lineNumber: bodyPasteLine.number,
        lineOffset: 7 - bodyPasteLine.from
      });
      await waitFrames();
      const bodyPasteSource = bodyPasteEditor.view.state.doc.toString();
      bodyPasteEditor.destroy();

      const bodyListEditor = await create('- one\n- two');
      bodyListEditor.view.dispatch({ selection: { anchor: 3 } });
      bodyListEditor.view.focus();
      bodyListEditor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: ']',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      const indentedBodyValue = bodyListEditor.view.state.doc.toString();
      bodyListEditor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: '[',
        altKey: true,
        bubbles: true,
        cancelable: true
      }));
      const outdentedBodyValue = bodyListEditor.view.state.doc.toString();
      bodyListEditor.destroy();

      const bodyMarkerEditor = await create('- parent\n  - child');
      const nestedBodyMarker = document.querySelectorAll<HTMLElement>('.meo-md-list-marker-bullet')[1];
      const nestedBodyDot = nestedBodyMarker?.querySelector<SVGElement>('.meo-md-list-marker-bullet-dot');
      const bodyListLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-list-line'));
      const bodyListGuideBackgrounds = bodyListLines
        .map((line) => getComputedStyle(line).backgroundImage)
        .filter((backgroundImage) => backgroundImage !== 'none');
      const nestedBodyGuideCount = bodyListLines.reduce((lineCount, line) => {
        return lineCount + [line, ...line.querySelectorAll<HTMLElement>('*')].reduce((count, element) => {
            return count + ['', '::before', '::after'].filter((pseudo) => {
              const style = getComputedStyle(element, pseudo || undefined);
              const hasLeftBorder = parseFloat(style.borderLeftWidth) > 0 &&
                style.borderLeftStyle !== 'none' &&
                style.borderLeftColor !== 'rgba(0, 0, 0, 0)';
              const hasGuideBackground = style.backgroundImage.includes('repeating-linear-gradient');
              return hasLeftBorder || hasGuideBackground;
            }).length;
          }, 0);
      }, 0);
      const bodyNestedMarkerState = {
        hollow: nestedBodyMarker?.classList.contains('meo-md-list-marker-bullet-hollow') ?? false,
        fill: nestedBodyDot ? getComputedStyle(nestedBodyDot).fill : '',
        stroke: nestedBodyDot ? getComputedStyle(nestedBodyDot).stroke : '',
        guideCount: nestedBodyGuideCount,
        guideBackgrounds: bodyListGuideBackgrounds
      };
      bodyMarkerEditor.destroy();

      const performanceEditor = await create(Array.from({ length: 800 }, (_, index) => `line ${index} asd`).join('\n'));
      const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
      let fullDocumentScans = 0;
      String.prototype.toLocaleLowerCase = function (...args: Parameters<String['toLocaleLowerCase']>) {
        if (String(this).length > 1_000) fullDocumentScans += 1;
        return originalToLocaleLowerCase.apply(String(this), args);
      };
      performanceEditor.setSearchQuery('asd');
      await waitFrames();
      const scansAfterQuery = fullDocumentScans;
      for (let index = 0; index < 12; index += 1) {
        performanceEditor.findNext('asd', { focusEditor: false });
      }
      await waitFrames();
      const navigationScans = fullDocumentScans - scansAfterQuery;
      String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
      performanceEditor.destroy();

      return {
        editingPreviewText,
        inlineDecorationCount,
        inlineLinkButtons,
        inlineOpenedHrefs,
        linkButtonsPreservedEditingCell,
        inlineEditingPreviewVisibility,
        bodyLinkButtons,
        bodyOpenedHrefs,
        lineBefore,
        lineAfter,
        lineNumberRightDelta,
        lineNumberNodeReused,
        interactionActive,
        borderlessActiveMatch,
        alignmentBeforeShift,
        alignmentAfterShift,
        renderedListState,
        nestedListIndentState,
        whitespaceState,
        continuedUnorderedValue,
        indentedTableValue,
        tableShortcutValue,
        tableShortcutSource,
        middleNavigationTarget,
        lastNavigationTarget,
        navigationSource,
        deleteRowsSource,
        deleteColumnsSource,
        continuedOrderedValue,
        exitedEmptyOrderedItemValue,
        indentedOrderedValue,
        outdentedOrderedValue,
        pastedImageMessageCount: pastedImageMessages.length,
        tablePasteValue,
        tablePasteSource,
        bodyPasteHandled,
        bodyPasteSource,
        indentedBodyValue,
        outdentedBodyValue,
        bodyNestedMarkerState,
        navigationScans
      };
    });

    const failures: string[] = [];
    if (result.editingPreviewText !== 'asdx') failures.push(`editing preview remained ${JSON.stringify(result.editingPreviewText)}`);
    if (
      result.inlineDecorationCount !== 5 ||
      JSON.stringify(result.inlineLinkButtons) !== JSON.stringify(['Open link', 'Jump within document']) ||
      JSON.stringify(result.inlineOpenedHrefs) !== JSON.stringify(['https://example.com', '#target']) ||
      !result.linkButtonsPreservedEditingCell ||
      result.inlineEditingPreviewVisibility !== 'hidden'
    ) {
      failures.push(`inline preview link controls were incomplete: ${JSON.stringify({ count: result.inlineDecorationCount, buttons: result.inlineLinkButtons, openedHrefs: result.inlineOpenedHrefs, preservedEditingCell: result.linkButtonsPreservedEditingCell, visibility: result.inlineEditingPreviewVisibility })}`);
    }
    if (
      JSON.stringify(result.bodyLinkButtons) !== JSON.stringify(['Open link', 'Jump within document']) ||
      JSON.stringify(result.bodyOpenedHrefs) !== JSON.stringify(['https://example.com', '#target'])
    ) {
      failures.push(`body link controls regressed: ${JSON.stringify({ buttons: result.bodyLinkButtons, openedHrefs: result.bodyOpenedHrefs })}`);
    }
    if (result.lineBefore !== '1' || result.lineAfter !== '2') failures.push(`table line number stayed ${result.lineBefore} -> ${result.lineAfter}`);
    if (result.lineNumberRightDelta === null || Math.abs(result.lineNumberRightDelta) > 0.5) {
      failures.push(`table line number right edge was offset by ${result.lineNumberRightDelta}px`);
    }
    if (!result.lineNumberNodeReused) failures.push('table line number DOM was recreated during scroll');
    if (result.interactionActive) failures.push('table interaction remained active after keyboard focus exit');
    if (!result.borderlessActiveMatch) failures.push('borderless table did not render the active search match');
    if (result.alignmentBeforeShift !== 'left' || result.alignmentAfterShift !== 'left') {
      failures.push(`manual header alignment changed after line shift: ${result.alignmentBeforeShift} -> ${result.alignmentAfterShift}`);
    }
    if (
      result.renderedListState.topLevelItems !== 2 ||
      result.renderedListState.nestedOrderedItems !== 1 ||
      result.renderedListState.nestedOrderedStart !== 3 ||
      result.renderedListState.plainLines !== 2 ||
      result.renderedListState.inlineCodeText !== 'literal<br>code' ||
      result.renderedListState.unorderedMarkerColor !== 'rgb(121, 184, 255)' ||
      result.renderedListState.orderedMarkerColor !== 'rgb(121, 184, 255)' ||
      result.renderedListState.editingPreviewVisibility !== 'hidden'
    ) {
      failures.push(`table cell list rendering was incorrect: ${JSON.stringify(result.renderedListState)}`);
    }
    if (
      result.nestedListIndentState.length !== 5 ||
      Math.abs(result.nestedListIndentState[1]?.left - result.nestedListIndentState[0]?.left) > 1 ||
      result.nestedListIndentState[3]?.left - result.nestedListIndentState[1]?.left < 12 ||
      result.nestedListIndentState[2]?.left - result.nestedListIndentState[3]?.left < 12 ||
      Math.abs(result.nestedListIndentState[4]?.left - result.nestedListIndentState[0]?.left) > 1
    ) {
      failures.push(`nested table list indentation was not visible: ${JSON.stringify(result.nestedListIndentState)}`);
    }
    if (result.whitespaceState.text !== '   indented' || result.whitespaceState.whiteSpace !== 'pre-wrap') {
      failures.push(`table line indentation was not visible: ${JSON.stringify(result.whitespaceState)}`);
    }
    if (result.continuedUnorderedValue !== '- first<br>\n- ') {
      failures.push(`unordered table continuation produced ${JSON.stringify(result.continuedUnorderedValue)}`);
    }
    if (result.indentedTableValue !== '- first<br>\n  - second') {
      failures.push(`table Alt+] indentation produced ${JSON.stringify(result.indentedTableValue)}`);
    }
    if (result.tableShortcutValue !== '- first<br>\n- second<br>\n- ') {
      failures.push(`table Enter shortcuts produced ${JSON.stringify(result.tableShortcutValue)}`);
    }
    if (!result.tableShortcutSource.includes('| - first<br>- second<br>- third |')) {
      failures.push(`table shortcut source was ${JSON.stringify(result.tableShortcutSource)}`);
    }
    if (
      result.middleNavigationTarget?.row !== '2' || result.middleNavigationTarget?.col !== '1' ||
      result.lastNavigationTarget?.row !== '3' || result.lastNavigationTarget?.col !== '1' ||
      !result.navigationSource.includes('|  |  |')
    ) {
      failures.push(`plain table Enter navigation failed: ${JSON.stringify({ middle: result.middleNavigationTarget, last: result.lastNavigationTarget, source: result.navigationSource })}`);
    }
    if (result.deleteRowsSource.includes('r1a') || result.deleteRowsSource.includes('r2a') || !result.deleteRowsSource.includes('r3a')) {
      failures.push(`multi-cell row deletion used only one active row: ${JSON.stringify(result.deleteRowsSource)}`);
    }
    if (result.deleteColumnsSource.includes('| A |') || result.deleteColumnsSource.includes('| B |') || !result.deleteColumnsSource.includes('| C |')) {
      failures.push(`multi-cell column deletion used only one active column: ${JSON.stringify(result.deleteColumnsSource)}`);
    }
    if (result.indentedBodyValue !== '  - one\n- two' || result.outdentedBodyValue !== '- one\n- two') {
      failures.push(`body Alt bracket indentation changed ${JSON.stringify(result.indentedBodyValue)} -> ${JSON.stringify(result.outdentedBodyValue)}`);
    }
    if (result.continuedOrderedValue !== '3. third<br>\n4. ' || result.exitedEmptyOrderedItemValue !== '3. third<br>\n') {
      failures.push(`ordered table continuation changed ${JSON.stringify(result.continuedOrderedValue)} -> ${JSON.stringify(result.exitedEmptyOrderedItemValue)}`);
    }
    if (
      result.indentedOrderedValue !== '3. first<br>\n  1. second<br>\n4. third' ||
      result.outdentedOrderedValue !== '3. first<br>\n4. second<br>\n5. third'
    ) {
      failures.push(`ordered table indentation changed ${JSON.stringify(result.indentedOrderedValue)} -> ${JSON.stringify(result.outdentedOrderedValue)}`);
    }
    if (result.pastedImageMessageCount !== 2) {
      failures.push(`table image paste sent ${result.pastedImageMessageCount} save requests`);
    }
    if (!/^ri!\[\d+\.png\]\(images\/pasted\.png\)ght$/.test(result.tablePasteValue)) {
      failures.push(`table image paste inserted outside the focused cell: ${JSON.stringify({ value: result.tablePasteValue, source: result.tablePasteSource })}`);
    }
    if (!result.bodyPasteHandled || !/^before !\[\d+\.png\]\(images\/pasted\.png\)after$/.test(result.bodyPasteSource)) {
      failures.push(`file-only body image paste was ignored: ${JSON.stringify({ handled: result.bodyPasteHandled, source: result.bodyPasteSource })}`);
    }
    if (!result.bodyNestedMarkerState.hollow || result.bodyNestedMarkerState.fill !== 'none' || result.bodyNestedMarkerState.stroke !== 'rgb(121, 184, 255)') {
      failures.push(`nested body bullet was not hollow: ${JSON.stringify(result.bodyNestedMarkerState)}`);
    }
    if (result.bodyNestedMarkerState.guideCount !== 0 || result.bodyNestedMarkerState.guideBackgrounds.length !== 0) {
      failures.push(`nested list still rendered ${result.bodyNestedMarkerState.guideCount} indentation guides`);
    }
    if (result.navigationScans > 0) failures.push(`search navigation rescanned the full document ${result.navigationScans} times`);

    await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__openedExternalHrefs = [];
      const editor = harness.createEditor({
        parent: app,
        text: '[body external](https://body.example) [body internal](#表格宽度测试)\n\n| Links | Editing |\n| --- | --- |\n| [table external](https://table.example) [table internal](#表格宽度测试) | active |\n\n# 表格宽度测试',
        initialMode: 'live',
        onApplyChanges() {},
        onOpenLink(href: string) {
          (window as any).__openedExternalHrefs.push(href);
        }
      });
      (window as any).__linkInteractionEditor = editor;
      (window as any).__openedLinkHrefs = [];
      app.addEventListener('meo-open-link', ((event: CustomEvent<{ href: string }>) => {
        (window as any).__openedLinkHrefs.push(event.detail.href);
      }) as EventListener);
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1]!.focus();
    });

    const clickOpenButton = async (index: number): Promise<string | null> => {
      const buttons = await page.$$('.meo-md-link-open-btn');
      const button = buttons[index];
      if (!button) return `button ${index} was missing`;
      try {
        await button.click();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const tableExternalClickError = await clickOpenButton(2);
    const bodyExternalClickError = await clickOpenButton(0);
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const bodyExternalExitedTable = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      return !(document.activeElement instanceof HTMLTextAreaElement) &&
        !editor.view.dom.classList.contains('meo-table-interaction-active');
    });
    const bodyLinks = await page.$$('.meo-md-link');
    const bodyTitleClickError = bodyLinks[0]
      ? await bodyLinks[0].click().then(() => null, (error) => error instanceof Error ? error.message : String(error))
      : 'body link title was missing';
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const bodyTitleResult = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      const firstBodyLine = document.querySelector<HTMLElement>('.cm-content > .cm-line');
      return {
        urlStillHidden: Boolean(firstBodyLine?.querySelector('.meo-md-link-url-hidden')),
        selectionHead: editor.view.state.selection.main.head
      };
    });
    await page.evaluate(() => document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1]!.focus());
    const tableInternalClickError = await clickOpenButton(3);
    const tableInternalTargetLine = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      return editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text;
    });
    const bodyInternalClickError = await clickOpenButton(1);
    const bodyInternalTargetLine = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      return editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text;
    });
    const interactionResult = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      const result = {
        openedHrefs: (window as any).__openedLinkHrefs,
        openedExternalHrefs: (window as any).__openedExternalHrefs,
        tableInteractionActive: editor.view.dom.classList.contains('meo-table-interaction-active'),
        pointerSelectionActive: editor.view.dom.classList.contains('meo-live-pointer-selecting')
      };
      editor.destroy();
      return result;
    });
    const clickErrors = [tableExternalClickError, tableInternalClickError, bodyExternalClickError, bodyInternalClickError, bodyTitleClickError]
      .filter((error): error is string => error !== null);
    if (
      clickErrors.length > 0 ||
      JSON.stringify(interactionResult.openedHrefs) !== JSON.stringify([
        'https://table.example',
        'https://body.example',
        '#表格宽度测试',
        '#表格宽度测试'
      ]) ||
      JSON.stringify(interactionResult.openedExternalHrefs) !== JSON.stringify([
        'https://table.example',
        'https://body.example'
      ]) ||
      !bodyExternalExitedTable ||
      tableInternalTargetLine !== '# 表格宽度测试' ||
      bodyInternalTargetLine !== '# 表格宽度测试' ||
      bodyTitleResult.urlStillHidden ||
      bodyTitleResult.selectionHead > 40 ||
      interactionResult.tableInteractionActive ||
      interactionResult.pointerSelectionActive
    ) {
      failures.push(`physical link interaction chain failed: ${JSON.stringify({ clickErrors, bodyExternalExitedTable, bodyTitleResult, tableInternalTargetLine, bodyInternalTargetLine, ...interactionResult })}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('table stability checks passed');
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
