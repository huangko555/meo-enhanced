import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-stability-'));

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

  const browser = await launchTestBrowser();
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

      const nestedInlineEditor = await create([
        '| Combination |',
        '| --- |',
        '| ***bold italic*** |',
        '| **bold with `code`** |',
        '| *italic with **bold*** |',
        '| ~~strike with **bold**~~ |'
      ].join('\n'));
      const nestedInlinePreviews = Array.from(document.querySelectorAll<HTMLElement>(
        'tbody .meo-md-html-table-cell-preview'
      ));
      const nestedInlineState = {
        texts: nestedInlinePreviews.map((preview) => preview.textContent ?? ''),
        strongEm: Boolean(nestedInlinePreviews[0]?.querySelector('strong > em')),
        strongCode: Boolean(nestedInlinePreviews[1]?.querySelector('strong > code')),
        emStrong: Boolean(nestedInlinePreviews[2]?.querySelector('em > strong')),
        strikeStrong: Boolean(nestedInlinePreviews[3]?.querySelector('.meo-md-strike > strong'))
      };
      nestedInlineEditor.destroy();

      const tableImageMarkdown = '![pixel](https://example.com/pixel.png)';
      const tableImageEditor = await create(`| Image |\n| --- |\n| ${tableImageMarkdown} |`);
      const tableImageCell = document.querySelector<HTMLTableCellElement>(
        'tbody td[data-table-row="1"][data-table-col="0"]'
      );
      const tableImageInput = tableImageCell?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
      const tableImagePreview = tableImageCell?.querySelector<HTMLElement>(
        '.meo-md-html-table-cell-preview'
      ) ?? null;
      const tableImage = tableImagePreview?.querySelector<HTMLElement>('.meo-md-image') ?? null;
      let tableImageEditingBeforeRelease = false;
      let tableImageForcedScrollCount = 0;
      if (tableImageCell) {
        tableImageCell.scrollIntoView = () => {
          tableImageForcedScrollCount += 1;
        };
      }
      if (tableImage) {
        const rect = tableImage.getBoundingClientRect();
        const pointer = {
          button: 0,
          pointerId: 39,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true
        };
        tableImage.dispatchEvent(new PointerEvent('pointerdown', pointer));
        tableImageEditingBeforeRelease = tableImageInput?.parentElement?.classList.contains('is-editing') ?? false;
        tableImage.dispatchEvent(new PointerEvent('pointerup', pointer));
        await waitFrames(1);
      }
      const tableImageClickState = {
        rendered: Boolean(tableImage),
        editingBeforeRelease: tableImageEditingBeforeRelease,
        forcedScrollCount: tableImageForcedScrollCount,
        previewHtml: tableImagePreview?.innerHTML ?? '',
        previewText: tableImagePreview?.textContent ?? '',
        inputFocused: document.activeElement === tableImageInput,
        editing: tableImageInput?.parentElement?.classList.contains('is-editing') ?? false,
        rawMarkdown: tableImageInput?.value ?? '',
        previewVisibility: tableImagePreview ? getComputedStyle(tableImagePreview).visibility : null
      };
      tableImageEditor.destroy();

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

      harness.replaceLocalLinkStatuses([]);
      const missingLinkEditor = await create('> [quoted missing](missing.md)\n\n| Links |\n| --- |\n| [table missing](missing.md) [present](present.md) [external](https://example.com) |');
      const initialMissingIndicatorCount = document.querySelectorAll('.meo-md-local-link-missing-icon').length;
      harness.replaceLocalLinkStatuses([
        { target: 'missing.md', exists: false },
        { target: 'present.md', exists: true }
      ]);
      missingLinkEditor.refreshDecorations();
      await waitFrames();
      const missingLinkStatusAfterRefresh = harness.getLocalLinkStatus('missing.md');
      const renderedLocalLinkHrefs = Array.from(document.querySelectorAll<HTMLElement>('[data-meo-link-href]'))
        .map((element) => element.getAttribute('data-meo-link-href'));
      const bodyMissingIndicators = Array.from(document.querySelectorAll<HTMLElement>(
        '.cm-line > .meo-md-local-link-missing-icon, .cm-line .meo-md-local-link-missing-icon'
      )).filter((indicator) => !indicator.closest('.meo-md-html-table-shell'));
      const tableMissingIndicators = Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-md-html-table-cell-preview .meo-md-local-link-missing-icon'
      ));
      const missingIndicatorColors = [...bodyMissingIndicators, ...tableMissingIndicators]
        .map((indicator) => getComputedStyle(indicator).color);
      harness.replaceLocalLinkStatuses([{ target: 'missing.md', exists: true }]);
      missingLinkEditor.refreshDecorations();
      await waitFrames();
      const resolvedMissingIndicatorCount = document.querySelectorAll('.meo-md-local-link-missing-icon').length;
      missingLinkEditor.destroy();

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

      const caretEditor = await create('| A | B |\n| --- | --- |\n| alpha bravo charlie | **wide** value |');
      const caretCell = document.querySelector<HTMLTableCellElement>('td[data-table-row="1"][data-table-col="0"]')!;
      const caretPreview = caretCell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const caretInput = caretCell.querySelector<HTMLTextAreaElement>('textarea')!;
      const widthsBeforeEntry = Array.from(document.querySelectorAll<HTMLTableCellElement>('tbody td'))
        .map((cell) => cell.getBoundingClientRect().width);
      const alphaText = Array.from(caretPreview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
        .find((element) => element.textContent?.includes('alpha bravo'))!;
      const alphaNode = alphaText.firstChild!;
      const caretRange = document.createRange();
      caretRange.setStart(alphaNode, 2);
      caretRange.setEnd(alphaNode, 3);
      const caretRect = caretRange.getBoundingClientRect();
      const mappedCaretOffset = harness.resolveInlineSourceOffsetAtPoint(
        caretPreview,
        caretRect.right,
        caretRect.top + caretRect.height / 2
      );
      alphaText.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 41,
        clientX: caretRect.right,
        clientY: caretRect.top + caretRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const clickEntryStateBeforePointerUp = {
        inputFocused: document.activeElement === caretInput,
        editing: caretInput.parentElement?.classList.contains('is-editing') ?? false,
        previewVisibility: getComputedStyle(caretPreview).visibility
      };
      alphaText.dispatchEvent(new PointerEvent('pointerup', {
        button: 0,
        pointerId: 41,
        clientX: caretRect.right,
        clientY: caretRect.top + caretRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      await waitFrames(1);
      const clickCaretOffset = caretInput.selectionStart;
      const widthsAfterEntry = Array.from(document.querySelectorAll<HTMLTableCellElement>('tbody td'))
        .map((cell) => cell.getBoundingClientRect().width);

      caretInput.blur();
      await waitFrames(1);
      const markdownCell = document.querySelector<HTMLTableCellElement>('td[data-table-row="1"][data-table-col="1"]')!;
      const markdownPreview = markdownCell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const markdownInput = markdownCell.querySelector<HTMLTextAreaElement>('textarea')!;
      const wideText = Array.from(markdownPreview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
        .find((element) => element.textContent === 'wide')!;
      const wideNode = wideText.firstChild!;
      const wideRange = document.createRange();
      wideRange.setStart(wideNode, 1);
      wideRange.setEnd(wideNode, 2);
      const wideRect = wideRange.getBoundingClientRect();
      wideText.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 43,
        clientX: wideRect.right,
        clientY: wideRect.top + wideRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const markdownEntryStateBeforePointerUp = {
        inputFocused: document.activeElement === markdownInput,
        editing: markdownInput.parentElement?.classList.contains('is-editing') ?? false,
        renderedText: markdownPreview.textContent
      };
      wideText.dispatchEvent(new PointerEvent('pointerup', {
        button: 0,
        pointerId: 43,
        clientX: wideRect.right,
        clientY: wideRect.top + wideRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      await waitFrames(1);
      const widthsAfterMarkdownEntry = Array.from(document.querySelectorAll<HTMLTableCellElement>('tbody td'))
        .map((cell) => cell.getBoundingClientRect().width);
      markdownInput.blur();
      await waitFrames(1);
      let dragTextElement = Array.from(caretPreview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
        .find((element) => element.textContent?.includes('alpha bravo'))!;
      const dragTextNode = dragTextElement.firstChild!;
      const dragStartRange = document.createRange();
      dragStartRange.setStart(dragTextNode, 0);
      dragStartRange.setEnd(dragTextNode, 1);
      const dragStartRect = dragStartRange.getBoundingClientRect();
      const dragEndRange = document.createRange();
      dragEndRange.setStart(dragTextNode, 6);
      dragEndRange.setEnd(dragTextNode, 7);
      const dragEndRect = dragEndRange.getBoundingClientRect();
      dragTextElement.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 47,
        clientX: dragStartRect.right,
        clientY: dragStartRect.top + dragStartRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      caretCell.closest('table')!.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 47,
        clientX: dragEndRect.right,
        clientY: dragEndRect.top + dragEndRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const releaseOnlyDraggedText = caretInput.value.slice(caretInput.selectionStart, caretInput.selectionEnd);
      caretInput.blur();
      await waitFrames(1);
      dragTextElement = Array.from(caretPreview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
        .find((element) => element.textContent?.includes('alpha bravo'))!;
      dragTextElement.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 42,
        clientX: dragStartRect.right,
        clientY: dragStartRect.top + dragStartRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      caretCell.closest('table')!.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 42,
        clientX: dragEndRect.right,
        clientY: dragEndRect.top + dragEndRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const dragStateBeforePointerUp = {
        inputFocused: document.activeElement === caretInput,
        editing: caretInput.parentElement?.classList.contains('is-editing') ?? false,
        previewVisibility: getComputedStyle(caretPreview).visibility
      };
      caretCell.closest('table')!.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 42,
        clientX: dragEndRect.right,
        clientY: dragEndRect.top + dragEndRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const draggedText = caretInput.value.slice(caretInput.selectionStart, caretInput.selectionEnd);
      caretInput.blur();
      await waitFrames(1);
      const table = caretCell.closest('table')!;
      const dispatchSelectionStart = (pointerId: number) => {
        dragTextElement.dispatchEvent(new PointerEvent('pointerdown', {
          button: 0,
          pointerId,
          clientX: dragStartRect.right,
          clientY: dragStartRect.top + dragStartRect.height / 2,
          bubbles: true,
          cancelable: true
        }));
      };
      const selectedPreviewText = () => {
        const selection = document.getSelection();
        return selection?.anchorNode && caretPreview.contains(selection.anchorNode)
          ? selection.toString()
          : '';
      };
      dispatchSelectionStart(44);
      table.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 44,
        bubbles: true,
        cancelable: true
      }));
      const cancelledPointerState = {
        inputFocused: document.activeElement === caretInput,
        editing: caretInput.parentElement?.classList.contains('is-editing') ?? false,
        selectedPreviewText: selectedPreviewText()
      };
      dispatchSelectionStart(45);
      table.dispatchEvent(new PointerEvent('lostpointercapture', {
        pointerId: 45
      }));
      const lostCaptureState = {
        inputFocused: document.activeElement === caretInput,
        editing: caretInput.parentElement?.classList.contains('is-editing') ?? false,
        selectedPreviewText: selectedPreviewText()
      };
      const outside = document.getElementById('outside')!;
      const outsideRect = outside.getBoundingClientRect();
      dispatchSelectionStart(46);
      outside.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 46,
        clientX: outsideRect.left + outsideRect.width / 2,
        clientY: outsideRect.top + outsideRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      outside.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 46,
        clientX: outsideRect.left + outsideRect.width / 2,
        clientY: outsideRect.top + outsideRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const outsideReleaseState = {
        inputFocused: document.activeElement === caretInput,
        editing: caretInput.parentElement?.classList.contains('is-editing') ?? false,
        selectedPreviewText: selectedPreviewText()
      };
      caretEditor.destroy();

      const diffEditor = await create('| A |\n| --- |\n| one |\n| changed |\n| three |');
      diffEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '| A |\n| --- |\n| one |\n| old |\n| three |'
      });
      await waitFrames(5);
      const tableDiffMarkers = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker'));
      const tableDiffMarkerLines = tableDiffMarkers.map((marker) => ({
        from: marker.dataset.meoLiveBlockStartLine,
        to: marker.dataset.meoLiveBlockEndLine,
        modified: marker.classList.contains('is-modified')
      }));
      const aggregateTableDiffMarkerCount = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-gutter-marker'))
        .filter((marker) => (
          !marker.classList.contains('meo-md-html-table-diff-marker') &&
          Number(marker.dataset.meoLiveBlockEndLine) - Number(marker.dataset.meoLiveBlockStartLine) > 0
        )).length;
      diffEditor.destroy();

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
        const textNode = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.parentElement?.closest('li') === item && node.textContent?.trim()
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP;
          }
        }).nextNode();
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
        return document.activeElement instanceof HTMLTextAreaElement && table.contains(document.activeElement);
      };

      const deleteRowsEditor = await create('| A | B |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |\n| r3a | r3b |');
      const crossCellDragFocusedInput = dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]')!,
        21
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const deleteRowsSource = deleteRowsEditor.view.state.doc.toString();
      deleteRowsEditor.destroy();

      const sortedDeleteEditor = await create('| N    |\n| ---- |\n| 3    |\n| 1    |\n| 2    |');
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        23
      );
      document.querySelector<HTMLButtonElement>('button[title="Sort selected column descending"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!,
        24
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const sortedNoncontiguousDeleteSource = sortedDeleteEditor.view.state.doc.toString();
      sortedDeleteEditor.destroy();

      const pendingEditDeleteEditor = await create('| A             |\n| ------------- |\n| keep          |\n| removed one   |\n| removed two   |\n| last          |');
      const retainedInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="0"] textarea'
      )!;
      retainedInput.focus();
      retainedInput.value = 'changed';
      retainedInput.dispatchEvent(new Event('input', { bubbles: true }));
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="3"][data-table-col="0"]')!,
        25
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames();
      const pendingEditDeleteSource = pendingEditDeleteEditor.view.state.doc.toString();
      pendingEditDeleteEditor.destroy();

      const editDiffBase = '| A      |\n| ------ |\n| old    |\n| keep   |';
      const editDiffEditor = await create(editDiffBase);
      editDiffEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: editDiffBase
      });
      const editDiffInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="0"] textarea'
      )!;
      editDiffInput.focus();
      editDiffInput.value = 'new';
      editDiffInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames(5);
      const editDiffSource = editDiffEditor.view.state.doc.toString();
      const editDiffMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        modified: marker.classList.contains('is-modified')
      }));
      editDiffEditor.destroy();

      const insertDiffBase = '| A      |\n| ------ |\n| one    |\n| two    |';
      const insertDiffEditor = await create(insertDiffBase);
      insertDiffEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: insertDiffBase
      });
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        26
      );
      document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames(5);
      const insertDiffSource = insertDiffEditor.view.state.doc.toString();
      const insertDiffMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added')
      }));
      insertDiffEditor.destroy();

      const sparseEditBase = '| A      | B      | C      |\n| ------ | ------ | ------ |\n| one    |';
      const sparseEditEditor = await create(sparseEditBase);
      sparseEditEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: sparseEditBase
      });
      const sparseEditInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="2"] textarea'
      )!;
      sparseEditInput.focus();
      sparseEditInput.value = 'three';
      sparseEditInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames(5);
      const sparseEditSource = sparseEditEditor.view.state.doc.toString();
      const sparseEditMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        modified: marker.classList.contains('is-modified')
      }));
      sparseEditEditor.destroy();

      const explicitEmptyEditor = await create('| A | B | C |\n| --- | --- | --- |\n|a||c|');
      const explicitEmptyInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="1"] textarea'
      )!;
      explicitEmptyInput.focus();
      explicitEmptyInput.value = 'b';
      explicitEmptyInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames(3);
      const explicitEmptySource = explicitEmptyEditor.view.state.doc.toString();
      explicitEmptyEditor.destroy();

      const paddedEmptyEditor = await create('| A |\n| --- |\n|    |');
      const paddedEmptyInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      paddedEmptyInput.focus();
      paddedEmptyInput.value = 'long';
      paddedEmptyInput.dispatchEvent(new Event('input', { bubbles: true }));
      (document.getElementById('outside') as HTMLButtonElement).focus();
      await waitFrames(3);
      const paddedEmptySource = paddedEmptyEditor.view.state.doc.toString();
      paddedEmptyEditor.destroy();

      const pendingAppendBase = '| A      |\n| ------ |\n| old    |';
      const pendingAppendEditor = await create(pendingAppendBase);
      pendingAppendEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: pendingAppendBase
      });
      const pendingAppendInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="0"] textarea'
      )!;
      pendingAppendInput.focus();
      pendingAppendInput.value = 'new';
      pendingAppendInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames(5);
      const pendingAppendSource = pendingAppendEditor.view.state.doc.toString();
      const pendingAppendMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added'),
        modified: marker.classList.contains('is-modified')
      }));
      pendingAppendEditor.destroy();

      const pendingPrependBase = '| A      |\n| ------ |\n| old    |';
      const pendingPrependEditor = await create(pendingPrependBase);
      pendingPrependEditor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: pendingPrependBase
      });
      const pendingPrependInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="1"][data-table-col="0"] textarea'
      )!;
      pendingPrependInput.focus();
      pendingPrependInput.value = 'new';
      pendingPrependInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('button[title="Insert row above"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames(5);
      const pendingPrependSource = pendingPrependEditor.view.state.doc.toString();
      const pendingPrependMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added'),
        modified: marker.classList.contains('is-modified')
      }));
      pendingPrependEditor.view.dispatch({
        changes: { from: 0, to: 0, insert: 'intro\n' },
        annotations: harness.addToHistoryAnnotation(false)
      });
      await waitFrames(3);
      document.querySelector<HTMLTableElement>('.meo-md-html-table')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      await waitFrames(5);
      const pendingPrependUndoSource = pendingPrependEditor.view.state.doc.toString();
      document.querySelector<HTMLTableElement>('.meo-md-html-table')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      await waitFrames(5);
      const pendingPrependRedoSource = pendingPrependEditor.view.state.doc.toString();
      const pendingPrependRedoMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added'),
        modified: marker.classList.contains('is-modified')
      }));
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        27
      );
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames(5);
      const trackedRowDeleteSource = pendingPrependEditor.view.state.doc.toString();
      document.querySelector<HTMLTableElement>('.meo-md-html-table')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      await waitFrames(5);
      const trackedRowDeleteUndoSource = pendingPrependEditor.view.state.doc.toString();
      const trackedRowDeleteUndoMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added'),
        modified: marker.classList.contains('is-modified')
      }));
      dragSelectCells(
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        document.querySelector<HTMLElement>('td[data-table-row="1"][data-table-col="0"]')!,
        28
      );
      document.querySelector<HTMLButtonElement>('button[title="Insert column right"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      await waitFrames(5);
      const trackedRowAfterColumnMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => ({
        line: marker.dataset.meoLiveBlockStartLine,
        added: marker.classList.contains('is-added'),
        modified: marker.classList.contains('is-modified')
      }));
      pendingPrependEditor.destroy();

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
        nestedInlineState,
        tableImageClickState,
        bodyLinkButtons,
        bodyOpenedHrefs,
        initialMissingIndicatorCount,
        bodyMissingIndicatorCount: bodyMissingIndicators.length,
        tableMissingIndicatorCount: tableMissingIndicators.length,
        missingIndicatorColors,
        resolvedMissingIndicatorCount,
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
        sortedNoncontiguousDeleteSource,
        pendingEditDeleteSource,
        editDiffSource,
        editDiffMarkers,
        insertDiffSource,
        insertDiffMarkers,
        sparseEditSource,
        sparseEditMarkers,
        explicitEmptySource,
        paddedEmptySource,
        pendingAppendSource,
        pendingAppendMarkers,
        pendingPrependSource,
        pendingPrependMarkers,
        pendingPrependUndoSource,
        pendingPrependRedoSource,
        pendingPrependRedoMarkers,
        trackedRowDeleteSource,
        trackedRowDeleteUndoSource,
        trackedRowDeleteUndoMarkers,
        trackedRowAfterColumnMarkers,
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
        navigationScans,
        missingLinkStatusAfterRefresh,
        renderedLocalLinkHrefs,
        clickCaretOffset,
        mappedCaretOffset,
        clickEntryStateBeforePointerUp,
        markdownEntryStateBeforePointerUp,
        dragStateBeforePointerUp,
        draggedText,
        cancelledPointerState,
        lostCaptureState,
        outsideReleaseState,
        releaseOnlyDraggedText,
        crossCellDragFocusedInput,
        maxWidthDelta: Math.max(...widthsBeforeEntry.flatMap((width, index) => [
          Math.abs(width - widthsAfterEntry[index]),
          Math.abs(width - widthsAfterMarkdownEntry[index])
        ])),
        tableDiffMarkerLines,
        aggregateTableDiffMarkerCount
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
      JSON.stringify(result.nestedInlineState.texts) !== JSON.stringify([
        'bold italic',
        'bold with code',
        'italic with bold',
        'strike with bold'
      ]) ||
      !result.nestedInlineState.strongEm ||
      !result.nestedInlineState.strongCode ||
      !result.nestedInlineState.emStrong ||
      !result.nestedInlineState.strikeStrong
    ) {
      failures.push(`nested table inline styles did not compose: ${JSON.stringify(result.nestedInlineState)}`);
    }
    if (
      !result.tableImageClickState.rendered ||
      result.tableImageClickState.editingBeforeRelease ||
      result.tableImageClickState.forcedScrollCount !== 0 ||
      !result.tableImageClickState.inputFocused ||
      !result.tableImageClickState.editing ||
      result.tableImageClickState.rawMarkdown !== '![pixel](https://example.com/pixel.png)' ||
      result.tableImageClickState.previewVisibility !== 'hidden'
    ) {
      failures.push(`table image click did not reveal its Markdown source: ${JSON.stringify(result.tableImageClickState)}`);
    }
    if (
      JSON.stringify(result.bodyLinkButtons) !== JSON.stringify(['Open link', 'Jump within document']) ||
      JSON.stringify(result.bodyOpenedHrefs) !== JSON.stringify(['https://example.com', '#target'])
    ) {
      failures.push(`body link controls regressed: ${JSON.stringify({ buttons: result.bodyLinkButtons, openedHrefs: result.bodyOpenedHrefs })}`);
    }
    if (
      result.initialMissingIndicatorCount !== 0 ||
      result.bodyMissingIndicatorCount !== 1 ||
      result.tableMissingIndicatorCount !== 1 ||
      result.missingIndicatorColors.some((color) => color !== 'rgb(224, 108, 117)') ||
      result.resolvedMissingIndicatorCount !== 0
    ) {
      failures.push(`missing local link indicators were inconsistent: ${JSON.stringify({ initial: result.initialMissingIndicatorCount, body: result.bodyMissingIndicatorCount, table: result.tableMissingIndicatorCount, colors: result.missingIndicatorColors, resolved: result.resolvedMissingIndicatorCount, status: result.missingLinkStatusAfterRefresh, hrefs: result.renderedLocalLinkHrefs })}`);
    }
    if (result.lineBefore !== '1' || result.lineAfter !== '2') failures.push(`table line number stayed ${result.lineBefore} -> ${result.lineAfter}`);
    if (result.lineNumberRightDelta === null || Math.abs(result.lineNumberRightDelta) > 0.5) {
      failures.push(`table line number right edge was offset by ${result.lineNumberRightDelta}px`);
    }
    if (!result.lineNumberNodeReused) failures.push('table line number DOM was recreated during scroll');
    if (result.interactionActive) failures.push('table interaction remained active after keyboard focus exit');
    if (result.clickCaretOffset !== 3) {
      failures.push(`table pointer entry placed the caret at ${result.clickCaretOffset} instead of 3 (mapped ${result.mappedCaretOffset})`);
    }
    if (
      result.clickEntryStateBeforePointerUp.inputFocused ||
      result.clickEntryStateBeforePointerUp.editing ||
      result.clickEntryStateBeforePointerUp.previewVisibility === 'hidden' ||
      result.markdownEntryStateBeforePointerUp.inputFocused ||
      result.markdownEntryStateBeforePointerUp.editing ||
      result.markdownEntryStateBeforePointerUp.renderedText !== 'wide value' ||
      result.dragStateBeforePointerUp.inputFocused ||
      result.dragStateBeforePointerUp.editing ||
      result.dragStateBeforePointerUp.previewVisibility === 'hidden'
    ) {
      failures.push(`table exposed Markdown source before pointerup: ${JSON.stringify({ click: result.clickEntryStateBeforePointerUp, markdown: result.markdownEntryStateBeforePointerUp, drag: result.dragStateBeforePointerUp })}`);
    }
    if (result.draggedText !== 'lpha b') {
      failures.push(`same-cell pointer drag selected ${JSON.stringify(result.draggedText)}`);
    }
    if (result.releaseOnlyDraggedText !== 'lpha b') {
      failures.push(`table drag ignored the pointerup position and selected ${JSON.stringify(result.releaseOnlyDraggedText)}`);
    }
    if (
      result.cancelledPointerState.inputFocused ||
      result.cancelledPointerState.editing ||
      result.cancelledPointerState.selectedPreviewText !== '' ||
      result.lostCaptureState.inputFocused ||
      result.lostCaptureState.editing ||
      result.lostCaptureState.selectedPreviewText !== '' ||
      result.outsideReleaseState.inputFocused ||
      result.outsideReleaseState.editing ||
      result.outsideReleaseState.selectedPreviewText !== '' ||
      result.crossCellDragFocusedInput
    ) {
      failures.push(`table pointer cleanup entered source mode or retained selection: ${JSON.stringify({ cancel: result.cancelledPointerState, lostCapture: result.lostCaptureState, outside: result.outsideReleaseState, crossCellFocused: result.crossCellDragFocusedInput })}`);
    }
    if (result.maxWidthDelta > 0.5) {
      failures.push(`table column width changed by ${result.maxWidthDelta}px when Markdown source became editable`);
    }
    if (
      JSON.stringify(result.tableDiffMarkerLines) !== JSON.stringify([{ from: '4', to: '4', modified: true }]) ||
      result.aggregateTableDiffMarkerCount !== 0
    ) {
      failures.push(`table diff markers were not source-row granular: ${JSON.stringify({ rows: result.tableDiffMarkerLines, aggregate: result.aggregateTableDiffMarkerCount })}`);
    }
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
    if (result.sortedNoncontiguousDeleteSource !== '| N    |\n| ---- |\n| 1    |') {
      failures.push(`sorted noncontiguous EOF row delete produced ${JSON.stringify(result.sortedNoncontiguousDeleteSource)}`);
    }
    if (result.pendingEditDeleteSource !== '| A             |\n| ------------- |\n| changed          |\n| last          |') {
      failures.push(`row delete with a retained pending edit rewrote unrelated lines: ${JSON.stringify(result.pendingEditDeleteSource)}`);
    }
    if (
      result.editDiffSource !== '| A      |\n| ------ |\n| new    |\n| keep   |' ||
      JSON.stringify(result.editDiffMarkers) !== JSON.stringify([{ line: '3', modified: true }])
    ) {
      failures.push(`single-cell edit produced a table-wide diff: ${JSON.stringify({ source: result.editDiffSource, markers: result.editDiffMarkers })}`);
    }
    if (
      result.insertDiffSource !== '| A      |\n| ------ |\n| one    |\n|  |\n| two    |' ||
      JSON.stringify(result.insertDiffMarkers) !== JSON.stringify([{ line: '4', added: true }])
    ) {
      failures.push(`row insertion produced a table-wide diff: ${JSON.stringify({ source: result.insertDiffSource, markers: result.insertDiffMarkers })}`);
    }
    if (
      result.sparseEditSource !== '| A      | B      | C      |\n| ------ | ------ | ------ |\n| one    |  | three |' ||
      JSON.stringify(result.sparseEditMarkers) !== JSON.stringify([{ line: '3', modified: true }])
    ) {
      failures.push(`sparse row edit was lost or normalized unrelated source: ${JSON.stringify({ source: result.sparseEditSource, markers: result.sparseEditMarkers })}`);
    }
    if (result.explicitEmptySource !== '| A | B | C |\n| --- | --- | --- |\n|a|b|c|') {
      failures.push(`explicit zero-width cell edit normalized its row: ${JSON.stringify(result.explicitEmptySource)}`);
    }
    if (result.paddedEmptySource !== '| A |\n| --- |\n| long |') {
      failures.push(`padded empty cell edit dropped its edge spacing: ${JSON.stringify(result.paddedEmptySource)}`);
    }
    if (
      result.pendingAppendSource !== '| A      |\n| ------ |\n| new    |\n|  |' ||
      JSON.stringify(result.pendingAppendMarkers) !== JSON.stringify([
        { line: '3', added: false, modified: true },
        { line: '4', added: true, modified: false }
      ])
    ) {
      failures.push(`EOF row insertion did not preserve its pending cell edit: ${JSON.stringify({ source: result.pendingAppendSource, markers: result.pendingAppendMarkers })}`);
    }
    if (
      result.pendingPrependSource !== '| A      |\n| ------ |\n|  |\n| new    |' ||
      result.pendingPrependUndoSource !== 'intro\n| A      |\n| ------ |\n| old    |' ||
      result.pendingPrependRedoSource !== `intro\n${result.pendingPrependSource}` ||
      JSON.stringify(result.pendingPrependMarkers) !== JSON.stringify([
        { line: '3', added: true, modified: false },
        { line: '4', added: false, modified: true }
      ]) ||
      JSON.stringify(result.pendingPrependRedoMarkers) !== JSON.stringify([
        { line: '4', added: true, modified: false },
        { line: '5', added: false, modified: true }
      ]) ||
      result.trackedRowDeleteSource !== 'intro\n| A      |\n| ------ |\n| new    |' ||
      result.trackedRowDeleteUndoSource !== result.pendingPrependRedoSource ||
      JSON.stringify(result.trackedRowDeleteUndoMarkers) !== JSON.stringify(result.pendingPrependRedoMarkers) ||
      !result.trackedRowAfterColumnMarkers.some((marker) => (
        marker.line === '4' && marker.added && !marker.modified
      ))
    ) {
      failures.push(`row insertion history lost its added-row identity: ${JSON.stringify({ source: result.pendingPrependSource, markers: result.pendingPrependMarkers, undo: result.pendingPrependUndoSource, redo: result.pendingPrependRedoSource, redoMarkers: result.pendingPrependRedoMarkers, deleted: result.trackedRowDeleteSource, deleteUndo: result.trackedRowDeleteUndoSource, deleteUndoMarkers: result.trackedRowDeleteUndoMarkers, afterColumnMarkers: result.trackedRowAfterColumnMarkers })}`);
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

    const waitForPageFrames = (count = 1) => page.evaluate(async (frameCount) => {
      for (let frame = 0; frame < frameCount; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, count);
    const clickPageElement = async (selector: string, index = 0): Promise<string | null> => {
      const elements = await page.$$(selector);
      const element = elements[index];
      if (!element) return `${selector} element ${index} was missing`;
      try {
        await element.click();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const wheelEditorToTop = async (): Promise<string | null> => {
      const scroller = await page.$('.cm-scroller');
      const box = await scroller?.boundingBox();
      if (!box) return 'editor scroller was missing';
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -10_000 });
      await waitForPageFrames(4);
      return null;
    };
    const screenshotPixelChangeRatio = async (before: string, after: string) => page.evaluate(async (images) => {
      const loadPixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [beforePixels, afterPixels] = await Promise.all([
        loadPixels(images.before),
        loadPixels(images.after)
      ]);
      let changed = 0;
      const pixelCount = Math.min(beforePixels.length, afterPixels.length) / 4;
      for (let offset = 0; offset < pixelCount * 4; offset += 4) {
        const delta = Math.abs(beforePixels[offset] - afterPixels[offset]) +
          Math.abs(beforePixels[offset + 1] - afterPixels[offset + 1]) +
          Math.abs(beforePixels[offset + 2] - afterPixels[offset + 2]);
        if (delta >= 24) changed += 1;
      }
      return pixelCount > 0 ? changed / pixelCount : 0;
    }, { before, after });

    const physicalSelectionPoints = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__physicalSelectionEditor = harness.createEditor({
        parent: app,
        text: '| A |\n| --- |\n| alpha bravo charlie |',
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const preview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const mapped = Array.from(preview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
        .find((element) => element.textContent?.includes('alpha bravo'))!;
      const textNode = mapped.firstChild!;
      const pointAt = (offset: number) => {
        const range = document.createRange();
        range.setStart(textNode, Math.max(0, offset - 1));
        range.setEnd(textNode, offset);
        const rect = range.getBoundingClientRect();
        return { x: rect.right, y: rect.top + rect.height / 2 };
      };
      const selectedRange = document.createRange();
      selectedRange.setStart(textNode, 1);
      selectedRange.setEnd(textNode, 7);
      const selectedRect = selectedRange.getBoundingClientRect();
      return {
        start: pointAt(1),
        end: pointAt(7),
        clip: {
          x: Math.max(0, selectedRect.left - 2),
          y: Math.max(0, selectedRect.top - 2),
          width: selectedRect.width + 4,
          height: selectedRect.height + 4
        }
      };
    });
    const unselectedPixels = await page.screenshot({
      clip: physicalSelectionPoints.clip,
      encoding: 'base64'
    });
    await page.mouse.move(physicalSelectionPoints.start.x, physicalSelectionPoints.start.y);
    await page.mouse.down();
    await page.mouse.move(physicalSelectionPoints.end.x, physicalSelectionPoints.end.y, { steps: 4 });
    const physicalDragState = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const preview = input.parentElement!.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      return {
        inputFocused: document.activeElement === input,
        editing: input.parentElement?.classList.contains('is-editing') ?? false,
        previewVisibility: getComputedStyle(preview).visibility,
        selectedPreviewText: document.getSelection()?.toString() ?? '',
        selectionBackground: getComputedStyle(preview, '::selection').backgroundColor
      };
    });
    const selectedPixels = await page.screenshot({
      clip: physicalSelectionPoints.clip,
      encoding: 'base64'
    });
    const selectionPixelChangeRatio = await screenshotPixelChangeRatio(
      String(unselectedPixels),
      String(selectedPixels)
    );
    const nativeTableTextDragPrevented = await page.evaluate(() => {
      const previewText = document.querySelector<HTMLElement>(
        'tbody .meo-md-html-table-cell-preview [data-meo-source-from]'
      )!;
      const dragEvent = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      const dispatched = previewText.dispatchEvent(dragEvent);
      return dragEvent.defaultPrevented && !dispatched;
    });
    await page.mouse.up();
    const physicalPointerUpState = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const result = {
        inputFocused: document.activeElement === input,
        selectedText: input.value.slice(input.selectionStart, input.selectionEnd)
      };
      (window as any).__physicalSelectionEditor.destroy();
      return result;
    });
    if (
      physicalDragState.inputFocused ||
      physicalDragState.editing ||
      physicalDragState.previewVisibility === 'hidden' ||
      physicalDragState.selectedPreviewText !== 'lpha b' ||
      physicalDragState.selectionBackground === '' ||
      physicalDragState.selectionBackground === 'transparent' ||
      physicalDragState.selectionBackground === 'rgba(0, 0, 0, 0)' ||
      selectionPixelChangeRatio < 0.08 ||
      !nativeTableTextDragPrevented ||
      !physicalPointerUpState.inputFocused ||
      physicalPointerUpState.selectedText !== 'lpha b'
    ) {
      failures.push(`physical table drag did not visibly select before pointerup: ${JSON.stringify({ drag: physicalDragState, selectionPixelChangeRatio, nativeTableTextDragPrevented, up: physicalPointerUpState })}`);
    }

    const runFocusedTableDrag = async (crossTable: boolean) => {
      const points = await page.evaluate(async (useSecondTable) => {
        const harness = (window as any).TableStabilityHarness;
        const app = document.getElementById('app')!;
        app.replaceChildren();
        const text = useSecondTable
          ? '| A |\n| --- |\n| focus |\n\n| B |\n| --- |\n| **alpha bravo** and *charlie* |'
          : '| A | B |\n| --- | --- |\n| focus | **alpha bravo** and *charlie* |';
        const editor = harness.createEditor({
          parent: app,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
        (window as any).__focusedTableDragEditor = editor;
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const tables = Array.from(document.querySelectorAll<HTMLTableElement>('.meo-md-html-table'));
        const firstInput = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
        firstInput.focus();
        firstInput.setSelectionRange(2, 2);
        const targetTable = useSecondTable ? tables[1] : tables[0];
        const targetPreview = useSecondTable
          ? targetTable.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!
          : targetTable.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview')[1]!;
        (window as any).__focusedTableDragTargetPreview = targetPreview;
        const mapped = Array.from(targetPreview.querySelectorAll<HTMLElement>('[data-meo-source-from]'))
          .find((element) => element.textContent?.includes('alpha bravo'))!;
        const textNode = document.createTreeWalker(mapped, NodeFilter.SHOW_TEXT).nextNode()!;
        const pointAt = (offset: number) => {
          const range = document.createRange();
          range.setStart(textNode, Math.max(0, offset - 1));
          range.setEnd(textNode, offset);
          const rect = range.getBoundingClientRect();
          return { x: rect.right, y: rect.top + rect.height / 2 };
        };
        const selectedRange = document.createRange();
        selectedRange.setStart(textNode, 1);
        selectedRange.setEnd(textNode, 7);
        const selectedRect = selectedRange.getBoundingClientRect();
        (window as any).__uncancelledTableDragStarts = 0;
        const onDragStart = (event: DragEvent) => {
          if (!event.defaultPrevented) (window as any).__uncancelledTableDragStarts += 1;
        };
        document.addEventListener('dragstart', onDragStart);
        (window as any).__removeFocusedTableDragListener = () => {
          document.removeEventListener('dragstart', onDragStart);
        };
        return {
          start: pointAt(1),
          end: pointAt(7),
          clip: {
            x: Math.max(0, selectedRect.left - 2),
            y: Math.max(0, selectedRect.top - 2),
            width: selectedRect.width + 4,
            height: selectedRect.height + 4
          }
        };
      }, crossTable);
      const before = await page.screenshot({ clip: points.clip, encoding: 'base64' });
      await page.mouse.move(points.start.x, points.start.y);
      await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 4 });
      const during = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll<HTMLTableElement>('.meo-md-html-table'));
        const focusedInput = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
        return {
          focusedInputStillActive: document.activeElement === focusedInput,
          selectedPreviewText: document.getSelection()?.toString() ?? '',
          originalTargetConnected: Boolean((window as any).__focusedTableDragTargetPreview?.isConnected),
          originalTargetStillRendered: document.contains((window as any).__focusedTableDragTargetPreview)
        };
      });
      const after = await page.screenshot({ clip: points.clip, encoding: 'base64' });
      const pixelChangeRatio = await screenshotPixelChangeRatio(String(before), String(after));
      await page.mouse.up();
      const up = await page.evaluate(() => {
        const active = document.activeElement;
        const result = {
          selectedText: active instanceof HTMLTextAreaElement
            ? active.value.slice(active.selectionStart, active.selectionEnd)
            : '',
          uncancelledDragStarts: (window as any).__uncancelledTableDragStarts ?? 0
        };
        (window as any).__removeFocusedTableDragListener?.();
        (window as any).__focusedTableDragEditor.destroy();
        return result;
      });
      return { during, pixelChangeRatio, up };
    };
    const focusedSameTableDrag = await runFocusedTableDrag(false);
    const focusedCrossTableDrag = await runFocusedTableDrag(true);
    for (const [label, state] of [
      ['same table', focusedSameTableDrag],
      ['cross table', focusedCrossTableDrag]
    ] as const) {
      if (
        !state.during.focusedInputStillActive ||
        state.during.selectedPreviewText !== 'lpha b' ||
        state.pixelChangeRatio < 0.08 ||
        state.up.selectedText !== 'lpha b' ||
        state.up.uncancelledDragStarts !== 0
      ) {
        failures.push(`focused ${label} drag was not visibly owned by the target table: ${JSON.stringify(state)}`);
      }
    }

    const deletedTableDiffState = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const baseText = '| A             |\n| ------------- |\n| keep          |\n| removed one   |\n| removed two   |\n| last          |';
      const editor = harness.createEditor({
        parent: app,
        text: baseText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText
      });
      (window as any).__deletedTableDiffEditor = editor;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const fromCell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!;
      const toCell = document.querySelector<HTMLElement>('td[data-table-row="3"][data-table-col="0"]')!;
      const table = fromCell.closest('table')!;
      const targetRect = toCell.getBoundingClientRect();
      fromCell.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 81,
        bubbles: true,
        cancelable: true
      }));
      table.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 81,
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.top + targetRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      table.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 81,
        bubbles: true,
        cancelable: true
      }));
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const tableDeletedMarkers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker.is-deleted')
      );
      const tableMarkerClasses = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')
      ).map((marker) => marker.className);
      const aggregateMarkers = Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-git-gutter-marker.is-added, .meo-git-gutter-marker.is-modified, .meo-git-gutter-marker.is-deleted'
      )).filter((marker) => !marker.classList.contains('meo-md-html-table-diff-marker'));
      const hoverMarker = tableDeletedMarkers[0] ?? aggregateMarkers[0] ?? null;
      const rect = hoverMarker?.getBoundingClientRect();
      const gutterRect = document.querySelector<HTMLElement>('.cm-gutter.meo-git-gutter')?.getBoundingClientRect();
      const deletionAtEnd = hoverMarker?.classList.contains('is-deleted-at-end') ?? false;
      return {
        source: editor.view.state.doc.toString(),
        markerGutterLeftDelta: rect && gutterRect ? rect.left - gutterRect.left : null,
        tableMarkerClasses,
        tableDeletedMarkers: tableDeletedMarkers.map((marker) => ({
          baselineFrom: marker.dataset.meoBaselineFromLine,
          baselineTo: marker.dataset.meoBaselineToLine,
          liveFrom: marker.dataset.meoLiveBlockStartLine,
          liveTo: marker.dataset.meoLiveBlockEndLine
        })),
        aggregateMarkerClasses: aggregateMarkers.map((marker) => marker.className),
        hoverPoint: rect ? {
          x: rect.left + Math.min(2, rect.width / 2),
          y: deletionAtEnd ? rect.bottom - 1 : rect.top + 1
        } : null
      };
    });
    if (deletedTableDiffState.hoverPoint) {
      await page.mouse.move(deletedTableDiffState.hoverPoint.x, deletedTableDiffState.hoverPoint.y);
      await waitForPageFrames(2);
    }
    const deletedTableDiffTooltip = await page.evaluate(() => {
      const deletion = document.querySelector<HTMLElement>('.meo-deletion-tooltip');
      const modified = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      const result = {
        deletionVisible: Boolean(deletion && !deletion.hidden),
        deletionText: deletion?.textContent ?? '',
        modifiedVisible: Boolean(modified && !modified.hidden),
        modifiedText: modified?.textContent ?? ''
      };
      (window as any).__deletedTableDiffEditor.destroy();
      return result;
    });
    if (
      deletedTableDiffState.source !== '| A             |\n| ------------- |\n| keep          |\n| last          |' ||
      deletedTableDiffState.markerGutterLeftDelta === null ||
      Math.abs(deletedTableDiffState.markerGutterLeftDelta) > 0.5 ||
      deletedTableDiffState.tableDeletedMarkers.length !== 1 ||
      deletedTableDiffState.tableDeletedMarkers[0]?.baselineFrom !== '4' ||
      deletedTableDiffState.tableDeletedMarkers[0]?.baselineTo !== '5' ||
      deletedTableDiffState.aggregateMarkerClasses.length !== 0 ||
      !deletedTableDiffTooltip.deletionVisible ||
      !deletedTableDiffTooltip.deletionText.includes('removed one') ||
      !deletedTableDiffTooltip.deletionText.includes('removed two') ||
      deletedTableDiffTooltip.deletionText.includes('| A |') ||
      deletedTableDiffTooltip.modifiedVisible
    ) {
      failures.push(`deleted table rows did not render a row-scoped deletion change: ${JSON.stringify({ markers: deletedTableDiffState, tooltip: deletedTableDiffTooltip })}`);
    }

    const adjacentTableDiffState = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const baseText = '| A             |\n| ------------- |\n| keep          |\n| removed one   |\n| removed two   |\n| old value     |\n| last          |';
      const editor = harness.createEditor({
        parent: app,
        text: baseText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText
      });
      (window as any).__adjacentTableDiffEditor = editor;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const editedInput = document.querySelector<HTMLTextAreaElement>(
        'td[data-table-row="4"][data-table-col="0"] textarea'
      )!;
      editedInput.focus();
      editedInput.value = 'new value';
      editedInput.dispatchEvent(new Event('input', { bubbles: true }));
      const fromCell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!;
      const toCell = document.querySelector<HTMLElement>('td[data-table-row="3"][data-table-col="0"]')!;
      const table = fromCell.closest('table')!;
      const targetRect = toCell.getBoundingClientRect();
      fromCell.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 82,
        bubbles: true,
        cancelable: true
      }));
      table.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 82,
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.top + targetRect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      table.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 82,
        bubbles: true,
        cancelable: true
      }));
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const markers = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker'));
      const markerState = markers.map((marker) => ({
        classes: marker.className,
        baselineFrom: marker.dataset.meoBaselineFromLine,
        baselineTo: marker.dataset.meoBaselineToLine,
        modifiedRanges: marker.dataset.meoModifiedRanges,
        liveFrom: marker.dataset.meoLiveBlockStartLine
      }));
      document.querySelector<HTMLTableElement>('.meo-md-html-table')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const undoSource = editor.view.state.doc.toString();
      const undoDeletedMarkerCount = document.querySelectorAll(
        '.meo-md-html-table-diff-marker.is-deleted'
      ).length;
      document.querySelector<HTMLTableElement>('.meo-md-html-table')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const redoSource = editor.view.state.doc.toString();
      const redoMarkers = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker'));
      const pointFor = (marker: HTMLElement | undefined, kind: 'deleted' | 'modified') => {
        if (!marker) return null;
        const rect = marker.getBoundingClientRect();
        return {
          x: rect.left + Math.min(2, rect.width / 2),
          y: kind === 'deleted' ? rect.top + 1 : rect.top + rect.height / 2
        };
      };
      return {
        source: editor.view.state.doc.toString(),
        markers: markerState,
        undoSource,
        undoDeletedMarkerCount,
        redoSource,
        deletedPoint: pointFor(redoMarkers.find((marker) => marker.classList.contains('is-deleted')), 'deleted'),
        modifiedPoint: pointFor(redoMarkers.find((marker) => marker.classList.contains('is-modified')), 'modified')
      };
    });
    const readVisibleDiffTooltip = () => page.evaluate(() => {
      const deletion = document.querySelector<HTMLElement>('.meo-deletion-tooltip');
      const modified = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      return {
        deletionVisible: Boolean(deletion && !deletion.hidden),
        deletionText: deletion?.textContent ?? '',
        modifiedVisible: Boolean(modified && !modified.hidden),
        modifiedText: modified?.textContent ?? ''
      };
    });
    let adjacentDeletedTooltip = null;
    if (adjacentTableDiffState.deletedPoint) {
      await page.mouse.move(adjacentTableDiffState.deletedPoint.x, adjacentTableDiffState.deletedPoint.y);
      await waitForPageFrames(2);
      adjacentDeletedTooltip = await readVisibleDiffTooltip();
    }
    let adjacentModifiedTooltip = null;
    if (adjacentTableDiffState.modifiedPoint) {
      await page.mouse.move(adjacentTableDiffState.modifiedPoint.x, adjacentTableDiffState.modifiedPoint.y);
      await waitForPageFrames(2);
      adjacentModifiedTooltip = await readVisibleDiffTooltip();
    }
    await page.evaluate(() => (window as any).__adjacentTableDiffEditor.destroy());
    const adjacentDeletedMarkers = adjacentTableDiffState.markers.filter((marker) => marker.classes.includes('is-deleted'));
    const adjacentModifiedMarkers = adjacentTableDiffState.markers.filter((marker) => marker.classes.includes('is-modified'));
    if (
      adjacentTableDiffState.source !== '| A             |\n| ------------- |\n| keep          |\n| new value     |\n| last          |' ||
      adjacentTableDiffState.undoSource !== '| A             |\n| ------------- |\n| keep          |\n| removed one   |\n| removed two   |\n| old value     |\n| last          |' ||
      adjacentTableDiffState.undoDeletedMarkerCount !== 0 ||
      adjacentTableDiffState.redoSource !== '| A             |\n| ------------- |\n| keep          |\n| new value     |\n| last          |' ||
      adjacentDeletedMarkers.length !== 1 ||
      adjacentDeletedMarkers[0]?.baselineFrom !== '4' ||
      adjacentDeletedMarkers[0]?.baselineTo !== '5' ||
      adjacentModifiedMarkers.length !== 1 ||
      adjacentModifiedMarkers[0]?.modifiedRanges !== '[[6,6]]' ||
      !adjacentDeletedTooltip?.deletionVisible ||
      adjacentDeletedTooltip.deletionText.includes('old value') ||
      !adjacentModifiedTooltip?.modifiedVisible ||
      adjacentModifiedTooltip.modifiedText.includes('removed one') ||
      adjacentModifiedTooltip.modifiedText.includes('removed two')
    ) {
      failures.push(`adjacent table deletion was swallowed by a modified marker: ${JSON.stringify({ state: adjacentTableDiffState, deletedTooltip: adjacentDeletedTooltip, modifiedTooltip: adjacentModifiedTooltip })}`);
    }

    const emptyTableRowDeletionState = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const baseText = '| A   | B   |\n| --- | --- |\n|     |     |\n|     |     |\n|     |     |';
      const editor = harness.createEditor({
        parent: app,
        text: baseText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText
      });
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="0"]')!;
      const table = cell.closest('table')!;
      const rect = cell.getBoundingClientRect();
      cell.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        pointerId: 83,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      table.dispatchEvent(new PointerEvent('pointerup', {
        button: 0,
        pointerId: 83,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true
      }));
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const markers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker.is-deleted')
      ).map((marker) => ({
        liveFrom: marker.dataset.meoLiveBlockStartLine,
        deletionRanges: marker.dataset.meoDeletionRanges
      }));
      const source = editor.view.state.doc.toString();
      editor.destroy();
      return { source, markers };
    });
    const emptyDeletionRanges = emptyTableRowDeletionState.markers.flatMap((marker) => {
      try {
        return JSON.parse(marker.deletionRanges ?? '[]') as Array<[number, number]>;
      } catch {
        return [];
      }
    });
    if (
      emptyTableRowDeletionState.source !== '| A   | B   |\n| --- | --- |\n|     |     |\n|     |     |' ||
      emptyTableRowDeletionState.markers.length !== 1 ||
      emptyDeletionRanges.length !== 1 ||
      emptyDeletionRanges[0][0] !== emptyDeletionRanges[0][1]
    ) {
      failures.push(`deleting one empty table row produced duplicate or widened deletion markers: ${JSON.stringify(emptyTableRowDeletionState)}`);
    }

    const repeatedEmptyTableRowDeletionState = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const emptyRow = '|     |     |';
      const baseText = ['| A   | B   |', '| --- | --- |', ...new Array(6).fill(emptyRow)].join('\n');
      const editor = harness.createEditor({
        parent: app,
        text: baseText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText
      });
      const waitFrames = async (count: number) => {
        for (let frame = 0; frame < count; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const deleteRow = async (row: number, pointerId: number) => {
        const cell = document.querySelector<HTMLElement>(
          `td[data-table-row="${row}"][data-table-col="0"]`
        )!;
        const table = cell.closest('table')!;
        const rect = cell.getBoundingClientRect();
        cell.dispatchEvent(new PointerEvent('pointerdown', {
          button: 0,
          pointerId,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true
        }));
        table.dispatchEvent(new PointerEvent('pointerup', {
          button: 0,
          pointerId,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true
        }));
        document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
          .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
        await waitFrames(5);
      };
      await waitFrames(3);
      await deleteRow(2, 84);
      await deleteRow(4, 85);
      const markers = Array.from(
        document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker.is-deleted')
      ).map((marker) => ({
        liveFrom: marker.dataset.meoLiveBlockStartLine,
        deletionRanges: marker.dataset.meoDeletionRanges
      }));
      const source = editor.view.state.doc.toString();
      editor.destroy();
      return { source, markers };
    });
    const expectedRepeatedEmptyDeletionSource = [
      '| A   | B   |',
      '| --- | --- |',
      ...new Array(4).fill('|     |     |')
    ].join('\n');
    const repeatedEmptyDeletionRanges = repeatedEmptyTableRowDeletionState.markers.flatMap((marker) => {
      try {
        return JSON.parse(marker.deletionRanges ?? '[]') as Array<[number, number]>;
      } catch {
        return [];
      }
    });
    if (
      repeatedEmptyTableRowDeletionState.source !== expectedRepeatedEmptyDeletionSource ||
      repeatedEmptyTableRowDeletionState.markers.length !== 2 ||
      repeatedEmptyDeletionRanges.length !== 2 ||
      repeatedEmptyDeletionRanges.some(([from, to]) => from !== to)
    ) {
      failures.push(`deleting two separate empty table rows retained an aggregate snapshot marker: ${JSON.stringify(repeatedEmptyTableRowDeletionState)}`);
    }

    await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__openedExternalHrefs = [];
      const linkTargetSpacer = Array.from({ length: 80 }, (_, index) => `spacer ${index + 1}`).join('\n');
      const editor = harness.createEditor({
        parent: app,
        text: `[body external](https://body.example) [body internal](#表格宽度测试)\n\n| Links | Editing |\n| --- | --- |\n| [table external](https://table.example) [table internal](#表格宽度测试) | active |\n\n${linkTargetSpacer}\n\n# 表格宽度测试\n\n${linkTargetSpacer}`,
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

    const tableInternalFromCellClickError = await clickPageElement('tbody .meo-md-link-open-btn', 1);
    const tableInternalFromCellSamples = await page.evaluate(async () => {
      const editor = (window as any).__linkInteractionEditor;
      const samples: Array<{
        line: string;
        scrollTop: number;
        targetViewportOffset: number | null;
        interactionActive: boolean;
        editorFocused: boolean;
        domSelectionInsideEditor: boolean;
        domSelectionCollapsed: boolean;
      }> = [];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const selectionHead = editor.view.state.selection.main.head;
        const targetCoords = editor.view.coordsAtPos(selectionHead);
        const viewportRect = editor.view.scrollDOM.getBoundingClientRect();
        const domSelection = window.getSelection();
        samples.push({
          line: editor.view.state.doc.lineAt(selectionHead).text,
          scrollTop: editor.view.scrollDOM.scrollTop,
          targetViewportOffset: targetCoords ? targetCoords.top - viewportRect.top : null,
          interactionActive: editor.view.dom.classList.contains('meo-table-interaction-active'),
          editorFocused: editor.view.hasFocus && document.activeElement === editor.view.contentDOM,
          domSelectionInsideEditor: Boolean(domSelection?.focusNode && editor.view.contentDOM.contains(domSelection.focusNode)),
          domSelectionCollapsed: Boolean(domSelection?.isCollapsed)
        });
      }
      return samples;
    });
    const tableInternalFromCellState = tableInternalFromCellSamples.at(-1)!;
    await page.evaluate(async () => {
      const editor = (window as any).__linkInteractionEditor;
      editor.view.scrollDOM.scrollTop = 0;
      editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1]!.focus();
    });
    const tableExternalClickError = await clickPageElement('tbody .meo-md-link-open-btn');
    const bodyExternalClickError = await clickPageElement('.meo-md-link-open-btn');
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const bodyExternalExitedTable = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      return !(document.activeElement instanceof HTMLTextAreaElement) &&
        !editor.view.dom.classList.contains('meo-table-interaction-active');
    });
    const bodyTitleClickError = await clickPageElement('.meo-md-link');
    await waitForPageFrames();
    const bodyTitleResult = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      const firstBodyLine = document.querySelector<HTMLElement>('.cm-content > .cm-line');
      return {
        urlStillHidden: Boolean(firstBodyLine?.querySelector('.meo-md-link-url-hidden')),
        selectionHead: editor.view.state.selection.main.head
      };
    });
    const tableInternalClickError = await clickPageElement('tbody .meo-md-link-open-btn', 1);
    await waitForPageFrames(2);
    const tableInternalTargetState = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      const selectionHead = editor.view.state.selection.main.head;
      const targetCoords = editor.view.coordsAtPos(selectionHead);
      const viewportRect = editor.view.scrollDOM.getBoundingClientRect();
      return {
        line: editor.view.state.doc.lineAt(selectionHead).text,
        scrollTop: editor.view.scrollDOM.scrollTop,
        targetViewportOffset: targetCoords ? targetCoords.top - viewportRect.top : null
      };
    });
    const firstWheelError = await wheelEditorToTop();
    const bodyInternalClickError = await clickPageElement('.meo-md-link-open-btn', 1);
    const bodyInternalTargetLine = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      return editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text;
    });
    const secondWheelError = await wheelEditorToTop();
    const reentryClickError = await clickPageElement(
      'tbody td[data-table-row="1"][data-table-col="1"] .meo-md-html-table-cell-preview'
    );
    await waitForPageFrames();
    const tableReentryState = await page.evaluate(() => {
      const editor = (window as any).__linkInteractionEditor;
      const active = document.activeElement;
      return {
        row: active instanceof HTMLTextAreaElement ? active.dataset.tableRow : null,
        col: active instanceof HTMLTextAreaElement ? active.dataset.tableCol : null,
        interactionActive: editor.view.dom.classList.contains('meo-table-interaction-active')
      };
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

    await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const editor = harness.createEditor({
        parent: app,
        text: '| Link | Editing |\n| --- | --- |\n| [jump](#nearby-target) | active |\n\n# Nearby target',
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__immediateReentryEditor = editor;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1]!.focus();
    });
    const immediateJumpClickError = await clickPageElement('tbody .meo-md-link-open-btn');
    const immediateJumpState = await page.evaluate(() => {
      const editor = (window as any).__immediateReentryEditor;
      const domSelection = window.getSelection();
      const preview = document.querySelector<HTMLElement>('tbody td[data-table-row="1"][data-table-col="1"] .meo-md-html-table-cell-preview');
      (window as any).__tableActivatedBeforeCellFocus = false;
      preview?.addEventListener('pointerdown', () => {
        (window as any).__tableActivatedBeforeCellFocus = (
          editor.view.dom.classList.contains('meo-table-interaction-active') &&
          !(document.activeElement instanceof HTMLTextAreaElement)
        );
      }, { once: true });
      return {
        line: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text,
        editorFocused: editor.view.hasFocus && document.activeElement === editor.view.contentDOM,
        domSelectionInsideEditor: Boolean(domSelection?.focusNode && editor.view.contentDOM.contains(domSelection.focusNode))
      };
    });
    const immediateReentryClickError = await clickPageElement(
      'tbody td[data-table-row="1"][data-table-col="1"] .meo-md-html-table-cell-preview'
    );
    await waitForPageFrames(2);
    const immediateReentryState = await page.evaluate(() => {
      const editor = (window as any).__immediateReentryEditor;
      const active = document.activeElement;
      const result = {
        row: active instanceof HTMLTextAreaElement ? active.dataset.tableRow : null,
        col: active instanceof HTMLTextAreaElement ? active.dataset.tableCol : null,
        interactionActive: editor.view.dom.classList.contains('meo-table-interaction-active'),
        activatedBeforeFocus: Boolean((window as any).__tableActivatedBeforeCellFocus)
      };
      editor.destroy();
      return result;
    });
    const clickErrors = [
      tableInternalFromCellClickError,
      tableExternalClickError,
      tableInternalClickError,
      bodyExternalClickError,
      bodyInternalClickError,
      bodyTitleClickError,
      firstWheelError,
      secondWheelError,
      reentryClickError,
      immediateJumpClickError,
      immediateReentryClickError
    ]
      .filter((error): error is string => error !== null);
    if (
      clickErrors.length > 0 ||
      JSON.stringify(interactionResult.openedHrefs) !== JSON.stringify([
        '#表格宽度测试',
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
      tableInternalFromCellState.line !== '# 表格宽度测试' ||
      tableInternalFromCellState.scrollTop < 100 ||
      tableInternalFromCellState.targetViewportOffset === null ||
      Math.abs(tableInternalFromCellState.targetViewportOffset) > 40 ||
      !tableInternalFromCellState.editorFocused ||
      !tableInternalFromCellState.domSelectionInsideEditor ||
      !tableInternalFromCellState.domSelectionCollapsed ||
      tableInternalTargetState.line !== '# 表格宽度测试' ||
      tableInternalTargetState.scrollTop < 100 ||
      tableInternalTargetState.targetViewportOffset === null ||
      Math.abs(tableInternalTargetState.targetViewportOffset) > 40 ||
      bodyInternalTargetLine !== '# 表格宽度测试' ||
      tableReentryState.row !== '1' ||
      tableReentryState.col !== '1' ||
      !tableReentryState.interactionActive ||
      bodyTitleResult.urlStillHidden ||
      bodyTitleResult.selectionHead > 40 ||
      !interactionResult.tableInteractionActive ||
      interactionResult.pointerSelectionActive ||
      immediateJumpState.line !== '# Nearby target' ||
      !immediateJumpState.editorFocused ||
      !immediateJumpState.domSelectionInsideEditor ||
      immediateReentryState.row !== '1' ||
      immediateReentryState.col !== '1' ||
      !immediateReentryState.interactionActive ||
      immediateReentryState.activatedBeforeFocus
    ) {
      failures.push(`physical link interaction chain failed: ${JSON.stringify({ clickErrors, bodyExternalExitedTable, bodyTitleResult, tableInternalFromCellSamples, tableInternalTargetState, bodyInternalTargetLine, tableReentryState, immediateJumpState, immediateReentryState, ...interactionResult })}`);
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
