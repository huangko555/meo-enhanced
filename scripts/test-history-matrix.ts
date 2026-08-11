import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

type BlockMode = 'preview' | 'split' | 'source';
type NeedleOccurrence = 'first' | 'last';
type HistoryTarget =
  | { kind: 'outer'; lineNeedle: string }
  | { kind: 'table'; undoValue: string; redoValue: string }
  | { kind: 'mermaid' | 'math'; marker: string; mode: Exclude<BlockMode, 'preview'> };

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-history-matrix-'));

async function pressHistoryShortcut(page: any, key: 'z' | 'y') {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

async function documentText(page: any): Promise<string> {
  return page.evaluate(() => (window as any).__historyMatrixEditor.getText());
}

async function waitForDocumentText(page: any, expected: string) {
  await page.waitForFunction((text) => (
    (window as any).__historyMatrixEditor.getText() === text
  ), {}, expected);
}

async function scrollToLineContaining(
  page: any,
  needle: string,
  occurrence: NeedleOccurrence = 'first',
  tableCellOverride: string | null = null
) {
  const tableCell = tableCellOverride
    ?? (needle.trim().startsWith('|') ? needle.split('|')[1]?.trim() ?? null : null);
  await page.evaluate(({ lineNeedle, targetOccurrence }) => {
    const editor = (window as any).__historyMatrixEditor;
    const lines = editor.getText().split('\n');
    const index = targetOccurrence === 'first'
      ? lines.findIndex((line: string) => line.includes(lineNeedle))
      : lines.findLastIndex((line: string) => line.includes(lineNeedle));
    if (index < 0) throw new Error(`Missing line: ${lineNeedle}`);
    editor.scrollToLine(index + 1, 'center');
  }, { lineNeedle: needle, targetOccurrence: occurrence });
  await page.waitForFunction(({ lineNeedle, expectedTableCell, targetOccurrence }) => {
    const editor = (window as any).__historyMatrixEditor;
    const scroller = document.querySelector<HTMLElement>('.cm-scroller');
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes(lineNeedle));
    const table = expectedTableCell
      ? Array.from(document.querySelectorAll<HTMLTextAreaElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
        )).find((candidate) => candidate.value === expectedTableCell)?.closest<HTMLElement>('.meo-md-html-table') ?? null
      : null;
    const lines = editor.getText().split('\n');
    const targetLineIndex = targetOccurrence === 'first'
      ? lines.findIndex((candidate: string) => candidate.includes(lineNeedle))
      : lines.findLastIndex((candidate: string) => candidate.includes(lineNeedle));
    let block: HTMLElement | null = null;
    for (let lineIndex = targetLineIndex; lineIndex >= 0; lineIndex -= 1) {
      if (!lines[lineIndex].startsWith('```mermaid') && lines[lineIndex].trim() !== '$$') continue;
      const openingFrom = lines.slice(0, lineIndex)
        .reduce((offset: number, candidate: string) => offset + candidate.length + 1, 0);
      block = document.querySelector<HTMLElement>(`[data-meo-block-from="${openingFrom}"]`);
      break;
    }
    const target = expectedTableCell ? table : block ?? line;
    if (!scroller || !target) return false;
    const viewport = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, {}, { lineNeedle: needle, expectedTableCell: tableCell, targetOccurrence: occurrence });
}

async function editOuterLine(page: any, needle: string, marker: string) {
  await scrollToLineContaining(page, needle);
  await page.evaluate((lineNeedle) => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes(lineNeedle));
    const content = line?.closest<HTMLElement>('.cm-content');
    if (!line || !content) throw new Error(`Missing visible line: ${lineNeedle}`);
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.focus();
  }, needle);
  await page.keyboard.type(marker);
  await page.waitForFunction((expected) => (
    (window as any).__historyMatrixEditor.getText().includes(expected)
  ), {}, marker);
}

async function editTableCell(page: any, tableLine: string, before: string, after: string) {
  await scrollToLineContaining(page, tableLine, 'first', before);
  await page.evaluate((currentValue) => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea'
    )).find((candidate) => candidate.value === currentValue);
    if (!input) throw new Error(`Missing table input: ${currentValue}`);
    input.focus();
    input.setSelectionRange(0, input.value.length);
  }, before);
  await page.keyboard.type(after);
  await page.evaluate(() => (window as any).__historyMatrixEditor.commitTransientEdits());
  await page.waitForFunction((expected) => (
    (window as any).__historyMatrixEditor.getText().includes(expected)
  ), {}, after);
}

async function editRenderedBlock(
  page: any,
  kind: 'mermaid' | 'math',
  lineNeedle: string,
  marker: string,
  finalMode: BlockMode,
  occurrence: NeedleOccurrence = 'first'
) {
  const modeButton = kind === 'mermaid' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
  const blockSelector = kind === 'mermaid' ? '.meo-mermaid-editing-block' : '.meo-latex-math-editing-block';
  const clickTargetModeButton = async () => {
    await page.evaluate(({ blockKind, needle, selector, targetOccurrence }) => {
      const editor = (window as any).__historyMatrixEditor;
      const lines = editor.getText().split('\n');
      const targetLineIndex = targetOccurrence === 'first'
        ? lines.findIndex((line: string) => line.includes(needle))
        : lines.findLastIndex((line: string) => line.includes(needle));
      for (let lineIndex = targetLineIndex; lineIndex >= 0; lineIndex -= 1) {
        const isOpening = blockKind === 'mermaid'
          ? lines[lineIndex].startsWith('```mermaid')
          : lines[lineIndex].trim() === '$$';
        if (!isOpening) continue;
        const openingFrom = lines.slice(0, lineIndex).reduce((offset: number, line: string) => offset + line.length + 1, 0);
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) => (
          candidate.closest<HTMLElement>('[data-meo-block-from]')?.dataset.meoBlockFrom === String(openingFrom)
        ));
        if (!button) {
          throw new Error(`Missing ${blockKind} mode button for ${needle}: ${JSON.stringify({
            targetLineIndex,
            openingLineIndex: lineIndex,
            openingFrom,
            buttons: Array.from(document.querySelectorAll<HTMLElement>(selector)).map((candidate) => ({
              from: candidate.closest<HTMLElement>('[data-meo-block-from]')?.dataset.meoBlockFrom ?? null
            }))
          })}`);
        }
        button.click();
        return;
      }
      throw new Error(`Missing ${blockKind} opening line for ${needle}`);
    }, { blockKind: kind, needle: lineNeedle, selector: modeButton, targetOccurrence: occurrence });
  };
  await scrollToLineContaining(page, lineNeedle, occurrence);
  await clickTargetModeButton();
  if (finalMode === 'source') {
    await clickTargetModeButton();
  }
  await page.evaluate(({ blockKind, needle, selector, targetOccurrence }) => {
    const editor = (window as any).__historyMatrixEditor;
    const lines = editor.getText().split('\n');
    const targetLineIndex = targetOccurrence === 'first'
      ? lines.findIndex((line: string) => line.includes(needle))
      : lines.findLastIndex((line: string) => line.includes(needle));
    let anchor = -1;
    for (let lineIndex = targetLineIndex; lineIndex >= 0; lineIndex -= 1) {
      if (blockKind === 'mermaid' ? lines[lineIndex].startsWith('```mermaid') : lines[lineIndex].trim() === '$$') {
        anchor = lines.slice(0, lineIndex).reduce((offset: number, line: string) => offset + line.length + 1, 0);
        break;
      }
    }
    const dataAttribute = blockKind === 'mermaid' ? 'data-meo-mermaid-anchor' : 'data-meo-latex-math-anchor';
    const block = document.querySelector<HTMLElement>(`${selector}[${dataAttribute}="${anchor}"]`);
    if (!block) throw new Error(`Missing ${blockKind} editing block for ${needle}`);
    const content = block.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error(`Missing ${blockKind} source editor for ${needle}`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.focus();
  }, {
    blockKind: kind,
    needle: lineNeedle,
    selector: blockSelector,
    targetOccurrence: occurrence
  });
  await page.keyboard.type(marker);
  await page.waitForFunction(({ selector, expected }) => {
    const active = document.activeElement;
    const block = active instanceof HTMLElement ? active.closest<HTMLElement>(selector) : null;
    return Boolean(block && (window as any).__historyMatrixEditor.getText().includes(expected));
  }, {}, { selector: blockSelector, expected: marker });
  if (finalMode === 'preview') {
    await clickTargetModeButton();
    await clickTargetModeButton();
  }
  const desiredMode = finalMode === 'preview' ? 'split' : finalMode;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actualMode = await page.evaluate(({ blockKind, needle, selector, targetOccurrence }) => {
      const editor = (window as any).__historyMatrixEditor;
      const lines = editor.getText().split('\n');
      const targetLineIndex = targetOccurrence === 'first'
        ? lines.findIndex((line: string) => line.includes(needle))
        : lines.findLastIndex((line: string) => line.includes(needle));
      for (let lineIndex = targetLineIndex; lineIndex >= 0; lineIndex -= 1) {
        const opening = blockKind === 'mermaid' ? lines[lineIndex].startsWith('```mermaid') : lines[lineIndex].trim() === '$$';
        if (!opening) continue;
        const openingFrom = lines.slice(0, lineIndex).reduce((offset: number, line: string) => offset + line.length + 1, 0);
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) => (
          candidate.closest<HTMLElement>('[data-meo-block-from]')?.dataset.meoBlockFrom === String(openingFrom)
        ));
        const block = button?.closest<HTMLElement>('[data-meo-block-from]');
        if (!block) return null;
        return block.classList.contains('is-source') ? 'source' : block.classList.contains('is-split') ? 'split' : 'preview';
      }
      return null;
    }, { blockKind: kind, needle: lineNeedle, selector: modeButton, targetOccurrence: occurrence });
    if (actualMode === desiredMode) break;
    await clickTargetModeButton();
  }
}

async function assertHistoryTarget(
  page: any,
  target: HistoryTarget,
  direction: 'undo' | 'redo',
  step: number
) {
  if (target.kind === 'outer') {
    await page.waitForFunction((needle) => {
      const content = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller .cm-content');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const line = focusElement?.closest<HTMLElement>('.cm-line');
      if (!content || !line || !content.contains(document.activeElement)) return false;
      const viewport = content.closest<HTMLElement>('.cm-scroller')!.getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      return line.textContent?.includes(needle)
        && rect.bottom > viewport.top
        && rect.top < viewport.bottom;
    }, {}, target.lineNeedle).catch((error: unknown) => {
      throw new Error(`${direction} step ${step} missed outer target: ${JSON.stringify(target)}`, { cause: error });
    });
    return;
  }

  if (target.kind === 'table') {
    const expectedValue = direction === 'undo' ? target.undoValue : target.redoValue;
    await page.waitForFunction((expected) => {
      const input = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      const rect = input?.getBoundingClientRect();
      const viewport = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller')?.getBoundingClientRect();
      return input?.value === expected
        && Boolean(rect && viewport && rect.bottom > viewport.top && rect.top < viewport.bottom);
    }, {}, expectedValue).catch((error: unknown) => {
      throw new Error(`${direction} step ${step} missed table target: ${JSON.stringify(target)}`, { cause: error });
    });
    return;
  }

  const markerExpected = direction === 'redo';
  await page.waitForFunction(({ kind, marker, mode, expected }) => {
    const selector = kind === 'mermaid' ? '.meo-mermaid-editing-block' : '.meo-latex-math-editing-block';
    const active = document.activeElement;
    const block = active instanceof HTMLElement ? active.closest<HTMLElement>(selector) : null;
    const content = block?.querySelector<HTMLElement>('.cm-content');
    const scroller = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller');
    if (!block || !content || !scroller) return false;
    const rect = block.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    const actualMode = block.classList.contains('is-source')
      ? 'source'
      : block.classList.contains('is-split') ? 'split' : null;
    return actualMode === mode
      && content.textContent?.includes(marker) === expected
      && rect.bottom > viewport.top
      && rect.top < viewport.bottom;
  }, {}, {
    kind: target.kind,
    marker: target.marker,
    mode: target.mode,
    expected: markerExpected
  }).catch((error: unknown) => {
    throw new Error(`${direction} step ${step} missed rendered-block target: ${JSON.stringify(target)}`, { cause: error });
  });
}

async function main() {
  const realFixturePath = process.env.MEO_HISTORY_REAL_FIXTURE?.trim() || null;
  const realFixtureText = realFixturePath ? fs.readFileSync(realFixturePath, 'utf8') : null;
  const fixture = realFixtureText
    ? {
        outerTop: 'represents the pro',
        table1Line: '| 三种写法 | 12312 |',
        table1FirstBefore: '三种写法',
        table1FirstAfter: '三种写法_REAL',
        table1LineAfterFirst: '| 三种写法_REAL | 12312 |',
        table1SecondBefore: '12312',
        table1SecondAfter: '12312_REAL',
        code: "CODE_BLOCK_SEARCH_NEEDLE = 'visible diff search target'",
        mermaidPreview: 'Start --> Check --> Done',
        mermaidSplit: 'MERMAID_SPLIT_SEARCH_TARGET',
        mermaidSource: 'A[Open Markdown File] --> B{Choose Editor}',
        mathPreview: '\\int \\!\\!\\! \\int \\!\\!\\! \\int_V',
        mathPreviewOccurrence: 'last' as NeedleOccurrence,
        mathSplit: '\\sum_{i=1}^{n}',
        mathSource: 'E = mc^2',
        table2Line: '| Bold        |    OK    | left text |',
        table2FirstBefore: 'Bold',
        table2FirstAfter: 'Bold_REAL',
        table2LineAfterFirst: '| Bold_REAL',
        table2SecondBefore: 'OK',
        table2SecondAfter: 'OK_REAL',
        table2ThirdBefore: 'left text',
        table2ThirdAfter: 'left text_REAL',
        extraOuter1: 'represents the probability',
        extraOuter2: '# Markdown Render Test123123',
        extraMermaid1: 'Start --> Check --> Done',
        extraMermaid2: 'A[Start]',
        extraMath1: '\\int \\!\\!\\! \\int_V',
        extraMath2: '\\int_{-\\infty}^{\\infty}',
        outerBottom: '123123123123123123123123123123123123123123',
        typingNeedle: 'represents the pro'
      }
    : {
        outerTop: 'PLAIN_TOP',
        table1Line: '| T1A | T1B |',
        table1FirstBefore: 'T1A',
        table1FirstAfter: 'T1A_EDIT',
        table1LineAfterFirst: '| T1A_EDIT | T1B |',
        table1SecondBefore: 'T1B',
        table1SecondAfter: 'T1B_EDIT',
        code: 'CODE_TARGET',
        mermaidPreview: 'MP_A --> MP_B',
        mermaidSplit: 'MS_A --> MS_B',
        mermaidSource: 'MC_A --> MC_B',
        mathPreview: 'mathPreview = 1',
        mathPreviewOccurrence: 'first' as NeedleOccurrence,
        mathSplit: 'mathSplit = 1',
        mathSource: 'mathSource = 1',
        table2Line: '| T2A | T2B |',
        table2FirstBefore: 'T2A',
        table2FirstAfter: 'T2A_EDIT',
        table2LineAfterFirst: 'T2A_EDIT',
        table2SecondBefore: 'T2B',
        table2SecondAfter: 'T2B_EDIT',
        table2ThirdBefore: 'left text',
        table2ThirdAfter: 'left text_EDIT',
        extraOuter1: 'EXTRA_OUTER_ONE',
        extraOuter2: 'EXTRA_OUTER_TWO',
        extraMermaid1: 'ME_EXTRA_A --> ME_EXTRA_B',
        extraMermaid2: 'ME_EXTRA_C --> ME_EXTRA_D',
        extraMath1: 'mathExtra = 1',
        extraMath2: 'mathExtraTwo = 1',
        outerBottom: 'PLAIN_BOTTOM',
        typingNeedle: 'gap-'
      };
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((fixtureText) => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="360" height="140"><text>${text.length}</text></svg>` };
        }
      };
      const gap = (name: string, count = 10) => Array.from({ length: count }, (_, index) => `${name} ${index + 1}`);
      const text = fixtureText ?? [
        'PLAIN_TOP',
        'EXTRA_OUTER_ONE',
        'EXTRA_OUTER_TWO',
        ...gap('gap-a'),
        '| T1H1 | T1H2 |',
        '| --- | --- |',
        '| T1A | T1B |',
        ...gap('gap-b', 100),
        '```ts',
        'const CODE_TARGET = true;',
        '```',
        ...gap('gap-c'),
        '```mermaid',
        'graph TD',
        'MP_A --> MP_B',
        '```',
        ...gap('gap-d'),
        '```mermaid',
        'graph TD',
        'MS_A --> MS_B',
        '```',
        ...gap('gap-e'),
        '```mermaid',
        'graph TD',
        'MC_A --> MC_B',
        '```',
        '```mermaid',
        'graph TD',
        'ME_EXTRA_A --> ME_EXTRA_B',
        '```',
        '```mermaid',
        'graph TD',
        'ME_EXTRA_C --> ME_EXTRA_D',
        '```',
        ...gap('gap-f'),
        '$$',
        'mathPreview = 1',
        '$$',
        ...gap('gap-g'),
        '$$',
        'mathSplit = 1',
        '$$',
        ...gap('gap-h'),
        '$$',
        'mathSource = 1',
        '$$',
        '$$',
        'mathExtra = 1',
        '$$',
        '$$',
        'mathExtraTwo = 1',
        '$$',
        ...gap('gap-i', 100),
        '| T2H1 | T2H2 | T2H3 |',
        '| --- | --- | --- |',
        '| T2A | T2B | left text |',
        ...gap('gap-j'),
        'PLAIN_BOTTOM'
      ].join('\n');
      (window as any).__historyMatrixEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, realFixtureText);
    await page.waitForFunction(() => Boolean(
      (window as any).__historyMatrixEditor?.getText()
      && document.querySelector('.cm-editor > .cm-scroller')
      && document.querySelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')
    ));

    const externalSyncDepth = await page.evaluate(() => {
      const editor = (window as any).__historyMatrixEditor;
      const text = editor.getText();
      const before = editor.getHistoryDepth();
      editor.setText(`${text}\nEXTERNAL_SYNC_PROBE`);
      editor.setText(text);
      const after = editor.getHistoryDepth();
      if (before.undo !== after.undo || before.redo !== after.redo) {
        throw new Error(`External sync changed history depth: ${JSON.stringify({ before, after })}`);
      }
      return after;
    });
    if (externalSyncDepth.undo !== 0 || externalSyncDepth.redo !== 0) {
      throw new Error(`Expected a clean history after external sync probe: ${JSON.stringify(externalSyncDepth)}`);
    }

    const pendingTableBaseline = await page.evaluate(() => (window as any).__historyMatrixEditor.getText());
    await scrollToLineContaining(page, fixture.table1Line);
    await page.evaluate((before) => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const input = table?.querySelector<HTMLTextAreaElement>('tbody textarea');
      if (!input) throw new Error('Missing first-table pending edit target');
      if (input.value !== before) throw new Error(`Unexpected first-table value: ${input.value}`);
      input.focus();
      input.value = `${before}_PENDING`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, fixture.table1FirstBefore);
    const commandConsumed = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const command = table?.closest<HTMLElement>('.meo-md-html-table-shell')
        ?.querySelector<HTMLButtonElement>('button[title="Insert row below"]');
      if (!command) throw new Error('Missing Insert row below control');
      return !command.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));
    });
    if (!commandConsumed) throw new Error('Insert row below command was not consumed');
    await page.waitForFunction(() => document.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
    )[0]?.querySelectorAll('tbody tr').length === 2);
    const afterPendingInsert = await page.evaluate(({ pending }) => {
      const editor = (window as any).__historyMatrixEditor;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      return {
        rowCount: table?.querySelectorAll('tbody tr').length ?? 0,
        text: editor.getText(),
        pending
      };
    }, { pending: `${fixture.table1FirstBefore}_PENDING` });
    if (
      afterPendingInsert.rowCount !== 2
      || !afterPendingInsert.text.includes(afterPendingInsert.pending)
      || !afterPendingInsert.text.includes(fixture.table2FirstBefore)
    ) {
      throw new Error(`Pending table edit leaked during structural command: ${JSON.stringify(afterPendingInsert)}`);
    }
    const waitForPendingStructureState = async (expected: {
      readonly text: string;
      readonly rowCount: number;
      readonly focused: boolean;
    }) => page.waitForFunction(({ text, rowCount, focused }) => {
      const editor = (window as any).__historyMatrixEditor;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const active = document.activeElement;
      return editor.getText() === text
        && table?.querySelectorAll('tbody tr').length === rowCount
        && (!focused || (active instanceof HTMLTextAreaElement && table.contains(active)));
    }, {}, expected);
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.undo();
      if (!applied) throw new Error('Pending table structure undo was not applied');
    });
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: 1, focused: true });
    await page.evaluate(async () => {
      const applied = await (window as any).__historyMatrixEditor.redo();
      if (!applied) throw new Error('Pending table structure redo was not applied');
    });
    await waitForPendingStructureState({ text: afterPendingInsert.text, rowCount: 2, focused: true });
    await page.evaluate((text) => (window as any).__historyMatrixEditor.setText(text), pendingTableBaseline);
    await waitForPendingStructureState({ text: pendingTableBaseline, rowCount: 1, focused: false });

    const versions = [await documentText(page)];
    const targets: HistoryTarget[] = [];
    const record = async (target: HistoryTarget) => {
      const text = await documentText(page);
      if (text === versions[versions.length - 1]) {
        throw new Error(`Edit did not change the document: ${JSON.stringify(target)}`);
      }
      targets.push(target);
      versions.push(text);
    };

    await editOuterLine(page, fixture.outerTop, ' PLAIN_TOP_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.outerTop });
    await editTableCell(page, fixture.table1Line, fixture.table1FirstBefore, fixture.table1FirstAfter);
    await record({ kind: 'table', undoValue: fixture.table1FirstBefore, redoValue: fixture.table1FirstAfter });
    await editTableCell(page, fixture.table1LineAfterFirst, fixture.table1SecondBefore, fixture.table1SecondAfter);
    await record({ kind: 'table', undoValue: fixture.table1SecondBefore, redoValue: fixture.table1SecondAfter });
    await editOuterLine(page, fixture.code, ' // CODE_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.code });

    await editRenderedBlock(page, 'mermaid', fixture.mermaidPreview, ' M_PREVIEW_EDIT', 'preview');
    await record({ kind: 'mermaid', marker: 'M_PREVIEW_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSplit, ' M_SPLIT_EDIT', 'split');
    await record({ kind: 'mermaid', marker: 'M_SPLIT_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'mermaid', fixture.mermaidSource, ' M_SOURCE_EDIT', 'source');
    await record({ kind: 'mermaid', marker: 'M_SOURCE_EDIT', mode: 'source' });

    const mathPreviewMarker = realFixtureText ? '555' : ' + MATH_PREVIEW_EDIT';
    await editRenderedBlock(
      page,
      'math',
      fixture.mathPreview,
      mathPreviewMarker,
      'preview',
      fixture.mathPreviewOccurrence
    );
    await record({ kind: 'math', marker: realFixtureText ? '555' : 'MATH_PREVIEW_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.mathSplit, ' + MATH_SPLIT_EDIT', 'split');
    await record({ kind: 'math', marker: 'MATH_SPLIT_EDIT', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.mathSource, ' + MATH_SOURCE_EDIT', 'source');
    await record({ kind: 'math', marker: 'MATH_SOURCE_EDIT', mode: 'source' });

    await editTableCell(page, fixture.table2Line, fixture.table2FirstBefore, fixture.table2FirstAfter);
    await record({ kind: 'table', undoValue: fixture.table2FirstBefore, redoValue: fixture.table2FirstAfter });
    await editTableCell(page, fixture.table2LineAfterFirst, fixture.table2SecondBefore, fixture.table2SecondAfter);
    await record({ kind: 'table', undoValue: fixture.table2SecondBefore, redoValue: fixture.table2SecondAfter });
    await editTableCell(page, fixture.table2LineAfterFirst, fixture.table2ThirdBefore, fixture.table2ThirdAfter);
    await record({ kind: 'table', undoValue: fixture.table2ThirdBefore, redoValue: fixture.table2ThirdAfter });
    await editOuterLine(page, fixture.outerBottom, ' PLAIN_BOTTOM_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.outerBottom });
    await editOuterLine(page, fixture.extraOuter1, ' EXTRA_ONE_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.extraOuter1 });
    await editOuterLine(page, fixture.extraOuter2, ' EXTRA_TWO_EDIT');
    await record({ kind: 'outer', lineNeedle: fixture.extraOuter2 });
    await editRenderedBlock(page, 'mermaid', fixture.extraMermaid1, ' M_EXTRA_ONE', 'source');
    await record({ kind: 'mermaid', marker: 'M_EXTRA_ONE', mode: 'source' });
    await editRenderedBlock(page, 'mermaid', fixture.extraMermaid2, ' M_EXTRA_TWO', 'split');
    await record({ kind: 'mermaid', marker: 'M_EXTRA_TWO', mode: 'split' });
    await editRenderedBlock(page, 'math', fixture.extraMath1, ' MATH_EXTRA_ONE', 'source');
    await record({ kind: 'math', marker: 'MATH_EXTRA_ONE', mode: 'source' });
    await editRenderedBlock(page, 'math', fixture.extraMath2, ' MATH_EXTRA_TWO', 'split');
    await record({ kind: 'math', marker: 'MATH_EXTRA_TWO', mode: 'split' });

    for (let index = targets.length - 1; index >= 0; index -= 1) {
      await pressHistoryShortcut(page, 'z');
      await waitForDocumentText(page, versions[index]);
      await assertHistoryTarget(page, targets[index], 'undo', targets.length - index);
    }

    for (let index = 0; index < targets.length; index += 1) {
      await pressHistoryShortcut(page, 'y');
      await waitForDocumentText(page, versions[index + 1]);
      await assertHistoryTarget(page, targets[index], 'redo', index + 1);
    }

    const heldUndoCountToFirstTable = targets.length - 2;
    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= heldUndoCountToFirstTable; count += 1) {
        await page.keyboard.down('z');
        const expected = versions[targets.length - count];
        await waitForDocumentText(page, expected);
      }
      await page.keyboard.up('z');
    } finally {
      await page.keyboard.up('Control');
    }
    await assertHistoryTarget(page, targets[2], 'undo', heldUndoCountToFirstTable);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= heldUndoCountToFirstTable; count += 1) {
        await page.keyboard.down('y');
        const expected = versions[2 + count];
        await waitForDocumentText(page, expected);
      }
      await page.keyboard.up('y');
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForDocumentText(page, versions[targets.length]);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= targets.length; count += 1) {
        await page.keyboard.press('z');
      }
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForDocumentText(page, versions[0]);
    await scrollToLineContaining(page, fixture.typingNeedle);
    const typingStart = await page.evaluate((typingNeedle) => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes(typingNeedle));
      const content = line?.closest<HTMLElement>('.cm-content');
      const scroller = content?.closest<HTMLElement>('.cm-scroller');
      if (!line || !content || !scroller) throw new Error('Missing visible post-history typing line');
      const range = document.createRange();
      range.selectNodeContents(line);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      content.focus();
      return { scrollTop: scroller.scrollTop, lineTop: line.getBoundingClientRect().top };
    }, fixture.typingNeedle);
    await page.keyboard.type(' TYPE_AFTER_HELD_HISTORY');
    await page.waitForFunction(() => (
      (window as any).__historyMatrixEditor.getText().includes('TYPE_AFTER_HELD_HISTORY')
    ));
    const typingEnd = await page.evaluate((typingNeedle) => {
      const editor = (window as any).__historyMatrixEditor;
      const content = document.querySelector<HTMLElement>('.cm-editor > .cm-scroller .cm-content');
      const scroller = content?.closest<HTMLElement>('.cm-scroller');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const line = focusElement?.closest<HTMLElement>('.cm-line');
      return {
        scrollTop: scroller?.scrollTop ?? null,
        focused: Boolean(content?.contains(document.activeElement)),
        lineTop: line?.getBoundingClientRect().top ?? null,
        line: line?.textContent ?? null,
        textContainsMarker: editor.getText().includes('TYPE_AFTER_HELD_HISTORY'),
        lineContainsNeedle: line?.textContent?.includes(typingNeedle) ?? false,
        activeTag: document.activeElement?.tagName ?? null
      };
    }, fixture.typingNeedle);
    if (
      !typingEnd.focused ||
      !typingEnd.textContainsMarker ||
      !typingEnd.lineContainsNeedle ||
      !typingEnd.line?.includes('TYPE_AFTER_HELD_HISTORY') ||
      typingEnd.scrollTop === null ||
      typingEnd.lineTop === null ||
      Math.abs(typingEnd.scrollTop - typingStart.scrollTop) > 2 ||
      Math.abs(typingEnd.lineTop - typingStart.lineTop) > 2
    ) {
      throw new Error(`Typing after held-Control history lost focus or scrolled: ${JSON.stringify({ typingStart, typingEnd })}`);
    }

    console.log(`history matrix checks passed (${targets.length} undo + ${targets.length} redo steps + held-Control mixed stress)`);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
