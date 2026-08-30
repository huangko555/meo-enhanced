import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

type OperationKind = 'outer' | 'html' | 'table' | 'mermaid' | 'math';

interface Operation {
  id: string;
  kind: OperationKind;
  needle: string;
  marker: string;
  tableCell?: string;
}

interface OperationRecord extends Operation {
  lineNumber: number;
  beforeText: string;
  afterText: string;
  editMetrics: MonitorMetrics;
}

interface MonitorMetrics {
  sampleCount: number;
  scrollSpan: number;
  targetTopSpan: number;
  unrelatedLineFlashCount: number;
  maxConsecutiveBodyFrames: number;
  changedSources: string[];
  transitions: Array<{ index: number; scrollTop: number; targetTop: number | null; activeTag: string | null }>;
}

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-uat-full-endurance-'));
const documentPath = process.argv[2]?.trim();
if (!documentPath) {
  throw new Error('Usage: bun scripts/test-uat-full-document-endurance.ts <markdown-document>');
}
const baselineText = fs.readFileSync(documentPath, 'utf8').replace(/\r\n/g, '\n');
const softFindings: Array<Record<string, unknown>> = [];

const topDownOperations: Operation[] = [
  { id: 'frontmatter', kind: 'outer', needle: 'MEO Undo Redo User Acceptance Test', marker: '__E01__' },
  { id: 'intro-quote', kind: 'outer', needle: 'UNDO-REDO-BASELINE-001', marker: '__E02__' },
  { id: 'plain-paragraph', kind: 'outer', needle: 'Alpha Bravo Charlie', marker: '__E03__' },
  { id: 'inline-format', kind: 'outer', needle: '高亮原值', marker: '__E04__' },
  { id: 'heading', kind: 'outer', needle: '3.1 二级标题 A', marker: '__E05__' },
  { id: 'unordered-list', kind: 'outer', needle: '二级项目 A.1', marker: '__E06__' },
  { id: 'task-list', kind: 'outer', needle: '未完成任务 A', marker: '__E07__' },
  { id: 'alert', kind: 'outer', needle: 'NOTE 原始内容', marker: '__E08__' },
  { id: 'short-ts', kind: 'outer', needle: "name: 'Alice'", marker: '__E09__' },
  { id: 'short-json', kind: 'outer', needle: '"count": 3', marker: '__E10__' },
  { id: 'short-plain-code', kind: 'outer', needle: 'plain line two', marker: '__E11__' },
  { id: 'long-python', kind: 'outer', needle: 'value_15 = 15', marker: '__E12__' },
  { id: 'long-javascript', kind: 'outer', needle: "rows.push('row-15')", marker: '__E13__' },
  { id: 'link', kind: 'outer', needle: '[OpenAI](https://openai.com)', marker: '__E14__' },
  { id: 'footnote', kind: 'outer', needle: 'Undo 脚注原始内容', marker: '__E15__' },
  { id: 'inline-math', kind: 'outer', needle: '$a^2 + b^2 = c^2$', marker: '__E16__' },
  { id: 'math-1', kind: 'math', needle: '\\int_{-\\infty}^{\\infty}', marker: 'MATH_E17' },
  { id: 'math-2', kind: 'math', needle: '\\operatorname{score}', marker: 'MATH_E18' },
  { id: 'mermaid-1', kind: 'mermaid', needle: 'A[Baseline A] --> B{Choose}', marker: 'MERMAID_E19' },
  { id: 'mermaid-2', kind: 'mermaid', needle: 'participant U as User', marker: 'MERMAID_E20' },
  { id: 'table-1', kind: 'table', needle: '| 1 | Alpha | Ready |', tableCell: 'Ready', marker: '__E21__' },
  { id: 'table-2', kind: 'table', needle: '| [链接](https://example.com) | `inline code` | 200.50 |', tableCell: '`inline code`', marker: '__E22__' },
  { id: 'table-3-last', kind: 'table', needle: '| 12 | A12 | B12 | C12 | D12 |', tableCell: 'D12', marker: '__E23__' },
  { id: 'table-4-long', kind: 'table', needle: '| Long Chinese |', tableCell: 'Pending', marker: '__E24__' },
  { id: 'table-5', kind: 'table', needle: '| color | blue |', tableCell: 'blue', marker: '__E25__' },
  { id: 'table-6', kind: 'table', needle: '| 2 | Edit second table | Second table changes |', tableCell: 'Second table changes', marker: '__E26__' },
  { id: 'html-details', kind: 'html', needle: 'HTML 折叠区域原始正文', marker: '__E27__' },
  { id: 'html-div', kind: 'html', needle: 'CENTER-BASELINE', marker: '__E28__' },
  { id: 'html-table', kind: 'html', needle: 'HTML-B1', marker: '__E29__' },
  { id: 'nested-quote', kind: 'outer', needle: 'LIST-QUOTE', marker: '__E30__' },
  { id: 'nested-code', kind: 'outer', needle: "nestedCode = 'BASELINE'", marker: '__E31__' },
  { id: 'nested-table', kind: 'table', needle: '| NA2 | NB2 |', tableCell: 'NB2', marker: '__E32__' },
  { id: 'stress-text', kind: 'outer', needle: 'STRESS-A-BASELINE', marker: '__E33__' },
  { id: 'stress-table', kind: 'table', needle: '| S2 | 222 | Second |', tableCell: '222', marker: '__E34__' },
  { id: 'document-end', kind: 'outer', needle: 'END-BASELINE-C', marker: '__E35__' }
];

const shuffledWave: Operation[] = [
  { id: 'shuffle-number', kind: 'outer', needle: '0123456789', marker: '__S01__' },
  { id: 'shuffle-mixed-format', kind: 'outer', needle: '粗体中包含', marker: '__S02__' },
  { id: 'shuffle-heading', kind: 'outer', needle: '3.2.1 三级标题 C', marker: '__S03__' },
  { id: 'shuffle-ordered-list', kind: 'outer', needle: '子项 TWO-A', marker: '__S04__' },
  { id: 'shuffle-nested-quote', kind: 'outer', needle: 'NESTED', marker: '__S05__' },
  { id: 'shuffle-code', kind: 'outer', needle: 'id: number', marker: '__S06__' },
  { id: 'shuffle-long-code', kind: 'outer', needle: 'return value_01 + value_25', marker: '__S07__' },
  { id: 'shuffle-relative-link', kind: 'outer', needle: './meo-undo-redo-uat.md', marker: '__S08__' },
  { id: 'shuffle-svg-image', kind: 'outer', needle: 'assets/local-preview.svg', marker: '__S08A__' },
  { id: 'shuffle-png-image', kind: 'outer', needle: 'assets/1785549139805.png', marker: '__S08B__' },
  { id: 'shuffle-footnote', kind: 'outer', needle: 'Redo 脚注原始内容', marker: '__S09__' },
  { id: 'shuffle-math', kind: 'math', needle: '\\sqrt{\\pi}', marker: 'MATH_S10' },
  { id: 'shuffle-mermaid', kind: 'mermaid', needle: 'E-->>U: Restore edit', marker: 'MERMAID_S11' },
  { id: 'shuffle-table-1', kind: 'table', needle: '| 2 | Bravo | Editing |', tableCell: 'Editing', marker: '__S12__' },
  { id: 'shuffle-table-3', kind: 'table', needle: '| 08 | A08 | B08 | C08 | D08 |', tableCell: 'C08', marker: '__S13__' },
  { id: 'shuffle-table-4', kind: 'table', needle: '| Mixed |', tableCell: 'Mixed', marker: '__S14__' },
  { id: 'shuffle-table-5', kind: 'table', needle: '| enabled | true |', tableCell: 'true', marker: '__S15__' },
  { id: 'shuffle-html-summary', kind: 'html', needle: 'HTML Details 原始标题', marker: '__S16__' },
  { id: 'shuffle-nested-formula', kind: 'outer', needle: '$x + y = z$', marker: '__S17__' },
  { id: 'shuffle-stress', kind: 'outer', needle: 'STRESS-C-BASELINE', marker: '__S18__' },
  { id: 'shuffle-end', kind: 'outer', needle: 'END-BASELINE-A', marker: '__S19__' }
];

function deterministicShuffle<T>(values: readonly T[]): T[] {
  let seed = 0x5eed037;
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const swap = seed % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function waitForFrames(page: import('puppeteer-core').Page, count = 6): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function waitForScrollStability(
  page: import('puppeteer-core').Page,
  stableFrames = 4,
  maxFrames = 60
): Promise<void> {
  await page.evaluate(async ({ requiredStableFrames, frameLimit }) => {
    const scroller = (window as any).__fullUatEditor.view.scrollDOM as HTMLElement;
    let previousTop = scroller.scrollTop;
    let previousHeight = scroller.scrollHeight;
    let stable = 0;
    for (let frame = 0; frame < frameLimit && stable < requiredStableFrames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const currentTop = scroller.scrollTop;
      const currentHeight = scroller.scrollHeight;
      stable = Math.abs(currentTop - previousTop) <= 0.5 && currentHeight === previousHeight
        ? stable + 1
        : 0;
      previousTop = currentTop;
      previousHeight = currentHeight;
    }
  }, { requiredStableFrames: stableFrames, frameLimit: maxFrames });
}

async function getText(page: import('puppeteer-core').Page): Promise<string> {
  return page.evaluate(() => (window as any).__fullUatEditor.getText());
}

async function waitForText(page: import('puppeteer-core').Page, expected: string): Promise<void> {
  await page.waitForFunction((text) => (window as any).__fullUatEditor.getText() === text, { timeout: 30_000 }, expected);
}

async function locateOperation(page: import('puppeteer-core').Page, operation: Operation): Promise<{ lineNumber: number; openingLine: number }> {
  return page.evaluate(({ needle, marker, kind }) => {
    const text = (window as any).__fullUatEditor.getText();
    const lines = text.split('\n');
    let lineIndex = lines.findIndex((line: string) => line.includes(needle));
    if (lineIndex < 0) lineIndex = lines.findIndex((line: string) => line.includes(marker));
    if (lineIndex < 0) throw new Error(`Missing operation needle: ${needle}`);
    let openingIndex = lineIndex;
    if (kind === 'mermaid') {
      while (openingIndex >= 0 && !lines[openingIndex]!.trimStart().startsWith('```mermaid')) openingIndex -= 1;
    } else if (kind === 'math') {
      while (openingIndex >= 0 && lines[openingIndex]!.trim() !== '$$') openingIndex -= 1;
    }
    if (openingIndex < 0) openingIndex = lineIndex;
    return { lineNumber: lineIndex + 1, openingLine: openingIndex + 1 };
  }, { needle: operation.needle, marker: operation.marker, kind: operation.kind });
}

async function centerLine(page: import('puppeteer-core').Page, lineNumber: number): Promise<void> {
  await page.evaluate((line) => (window as any).__fullUatEditor.scrollToLine(line, 'center'), lineNumber);
  await waitForScrollStability(page);
}

async function startMonitor(
  page: import('puppeteer-core').Page,
  lineNumber: number,
  excludedFrom: number,
  excludedTo: number,
  trackFocusedControl = false
): Promise<void> {
  await page.evaluate(({ targetLine, excludeFrom, excludeTo, focusedControl }) => {
    const editor = (window as any).__fullUatEditor;
    const scroller = editor.view.scrollDOM as HTMLElement;
    const readVisibleLines = () => {
      const result: Record<string, string> = {};
      const sourceCounts = new Map<string, number>();
      for (const sourceLine of editor.view.state.doc.toString().split('\n')) {
        sourceCounts.set(sourceLine, (sourceCounts.get(sourceLine) ?? 0) + 1);
      }
      for (const line of Array.from(editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))) {
        try {
          const position = editor.view.posAtDOM(line, 0);
          const number = editor.view.state.doc.lineAt(position).number;
          const source = editor.view.state.doc.line(number).text;
          if (!source || sourceCounts.get(source) !== 1) continue;
          const rect = line.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          if (number < excludeFrom || number > excludeTo) {
            if (rect.bottom > viewport.top && rect.top < viewport.bottom) result[source] = line.textContent ?? '';
          }
        } catch {}
      }
      return result;
    };
    let lastFocusedControlTop: number | null = null;
    const targetTop = () => {
      if (focusedControl) {
        const active = document.activeElement;
        if (active instanceof HTMLTextAreaElement) {
          lastFocusedControlTop = active.getBoundingClientRect().top;
        }
        return lastFocusedControlTop;
      }
      const line = editor.view.state.doc.line(Math.min(Math.max(targetLine, 1), editor.view.state.doc.lines));
      return editor.view.coordsAtPos(line.from)?.top ?? null;
    };
    const monitor = {
      running: true,
      baseline: readVisibleLines(),
      samples: [] as Array<{
        scrollTop: number;
        targetTop: number | null;
        activeTag: string | null;
        changedLines: number;
      }>,
      changedSources: [] as string[]
    };
    (window as any).__fullUatMonitor = monitor;
    const sample = () => {
      if (!monitor.running) return;
      const current = readVisibleLines();
      let changedLines = 0;
      for (const [line, text] of Object.entries(monitor.baseline)) {
        if (line in current && current[line] !== text) {
          changedLines += 1;
          if (!monitor.changedSources.includes(line)) monitor.changedSources.push(line);
        }
      }
      monitor.samples.push({
        scrollTop: scroller.scrollTop,
        targetTop: targetTop(),
        activeTag: document.activeElement?.tagName ?? null,
        changedLines
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { targetLine: lineNumber, excludeFrom: excludedFrom, excludeTo: excludedTo, focusedControl: trackFocusedControl });
}

async function stopMonitor(page: import('puppeteer-core').Page): Promise<MonitorMetrics> {
  return page.evaluate(() => {
    const monitor = (window as any).__fullUatMonitor as {
      running: boolean;
      changedSources: string[];
      samples: Array<{ scrollTop: number; targetTop: number | null; activeTag: string | null; changedLines: number }>;
    };
    monitor.running = false;
    const samples = monitor.samples;
    const scrolls = samples.map((sample) => sample.scrollTop);
    const targetTops = samples.map((sample) => sample.targetTop).filter((value): value is number => value !== null);
    let currentBodyFrames = 0;
    let maxConsecutiveBodyFrames = 0;
    for (const sample of samples) {
      currentBodyFrames = sample.activeTag === 'BODY' ? currentBodyFrames + 1 : 0;
      maxConsecutiveBodyFrames = Math.max(maxConsecutiveBodyFrames, currentBodyFrames);
    }
    delete (window as any).__fullUatMonitor;
    const transitions = samples
      .map((sample, index) => ({ index, ...sample }))
      .filter((sample, index, all) => (
        index === 0 || sample.scrollTop !== all[index - 1]?.scrollTop || sample.targetTop !== all[index - 1]?.targetTop
      ))
      .map(({ index, scrollTop, targetTop, activeTag }) => ({ index, scrollTop, targetTop, activeTag }));
    return {
      sampleCount: samples.length,
      scrollSpan: scrolls.length ? Math.max(...scrolls) - Math.min(...scrolls) : 0,
      targetTopSpan: targetTops.length ? Math.max(...targetTops) - Math.min(...targetTops) : 0,
      unrelatedLineFlashCount: samples.reduce((total, sample) => total + sample.changedLines, 0),
      maxConsecutiveBodyFrames,
      changedSources: monitor.changedSources,
      transitions
    };
  });
}

function assertEditMetrics(operation: Operation, metrics: MonitorMetrics): void {
  if (
    operation.kind === 'table' && metrics.targetTopSpan > 2 &&
    metrics.unrelatedLineFlashCount === 0 && metrics.maxConsecutiveBodyFrames <= 1
  ) {
    softFindings.push({
      kind: 'table-input-visual-movement',
      operation: operation.id,
      targetTopSpan: metrics.targetTopSpan,
      scrollSpan: metrics.scrollSpan,
      transitions: metrics.transitions
    });
    return;
  }
  if (
    metrics.targetTopSpan > 2 ||
    metrics.unrelatedLineFlashCount > 0 || metrics.maxConsecutiveBodyFrames > 1
  ) {
    throw new Error(`Edit viewport/flicker failure: ${JSON.stringify({ operation, metrics })}`);
  }
}

async function prepareOuterSelection(page: import('puppeteer-core').Page, operation: Operation): Promise<void> {
  await page.evaluate(({ needle, marker }) => {
    const editor = (window as any).__fullUatEditor;
    const text = editor.getText();
    const index = text.indexOf(needle);
    if (index < 0) throw new Error(`Missing outer edit needle: ${needle}`);
    const position = index + needle.length;
    editor.revealSelection(position, position, { focusEditor: true, align: 'center' });
    editor.view.contentDOM.focus({ preventScroll: true });
  }, { needle: operation.needle, marker: operation.marker });
  await waitForFrames(page, 5);
}

async function editOuter(page: import('puppeteer-core').Page, operation: Operation, lineNumber: number): Promise<void> {
  await page.keyboard.type(operation.marker);
  await page.waitForFunction(({ needle, marker }) => (
    (window as any).__fullUatEditor.getText().includes(`${needle}${marker}`)
  ), {}, { needle: operation.needle, marker: operation.marker });
  const focus = await page.evaluate((expectedLine) => {
    const editor = (window as any).__fullUatEditor;
    return {
      focused: editor.view.hasFocus,
      line: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
      expectedLine
    };
  }, lineNumber);
  if (!focus.focused || focus.line !== lineNumber) throw new Error(`Outer edit focus drift: ${JSON.stringify({ operation, focus })}`);
}

async function prepareHtmlSource(page: import('puppeteer-core').Page, operation: Operation): Promise<void> {
  await page.evaluate((needle) => {
    const editor = (window as any).__fullUatEditor;
    const sourcePosition = editor.getText().indexOf(needle);
    if (sourcePosition < 0) throw new Error(`Missing HTML edit needle: ${needle}`);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.meo-md-html-source-toggle'));
    const ranked = buttons.map((button) => {
      const block = button.closest<HTMLElement>('.meo-md-html-block[data-meo-html-from]');
      const blockFrom = Number(block?.dataset.meoHtmlFrom);
      const blockTo = Number(block?.dataset.meoHtmlTo);
      if (Number.isFinite(blockFrom) && Number.isFinite(blockTo) && sourcePosition >= blockFrom && sourcePosition <= blockTo) {
        return { button, distance: 0 };
      }
      try {
        return { button, distance: Math.abs(editor.view.posAtDOM(button) - sourcePosition) };
      } catch {
        return { button, distance: Number.POSITIVE_INFINITY };
      }
    }).sort((left, right) => left.distance - right.distance);
    const target = ranked[0];
    if (!target || !Number.isFinite(target.distance)) {
      throw new Error(`Missing HTML source toggle for: ${needle}`);
    }
    target.button.click();
  }, operation.needle);
  await page.waitForFunction((needle) => {
    const editor = (window as any).__fullUatEditor;
    const position = editor.getText().indexOf(needle);
    if (position < 0) return false;
    const line = editor.view.state.doc.lineAt(position);
    return Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-html-source-range'))
      .some((element) => {
        try {
          return editor.view.state.doc.lineAt(editor.view.posAtDOM(element)).number === line.number;
        } catch {
          return false;
        }
      });
  }, { timeout: 10_000 }, operation.needle);
}

async function editHtml(page: import('puppeteer-core').Page, operation: Operation, lineNumber: number): Promise<void> {
  await page.evaluate((needle) => {
    const editor = (window as any).__fullUatEditor;
    const text = editor.getText();
    const index = text.indexOf(needle);
    if (index < 0) throw new Error(`Missing revealed HTML edit needle: ${needle}`);
    const position = index + needle.length;
    editor.revealSelection(position, position, { focusEditor: true, align: 'center' });
    editor.view.contentDOM.focus({ preventScroll: true });
  }, operation.needle);
  await waitForFrames(page, 5);
  await page.keyboard.type(operation.marker);
  await page.waitForFunction(({ needle, marker }) => (
    (window as any).__fullUatEditor.getText().includes(`${needle}${marker}`)
  ), {}, { needle: operation.needle, marker: operation.marker });
  const focus = await page.evaluate((expectedLine) => {
    const editor = (window as any).__fullUatEditor;
    return {
      focused: editor.view.hasFocus,
      line: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
      sourceRangeVisible: Boolean(document.querySelector('.meo-md-html-source-range')),
      expectedLine
    };
  }, lineNumber);
  if (!focus.focused || focus.line !== lineNumber || !focus.sourceRangeVisible) {
    throw new Error(`HTML edit focus/mode drift: ${JSON.stringify({ operation, focus })}`);
  }
}

async function prepareTableInput(page: import('puppeteer-core').Page, operation: Operation, lineNumber: number): Promise<void> {
  const before = operation.tableCell!;
  await page.waitForFunction(({ sourceLine, value }) => {
    const editor = (window as any).__fullUatEditor;
    const sourceValues = editor.view.state.doc.line(sourceLine).text
      .trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell: string) => cell.trim());
    return Array.from(document.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr'
    )).some((row) => {
      const inputs = Array.from(row.querySelectorAll<HTMLTextAreaElement>('textarea'));
      return inputs.length === sourceValues.length
        && inputs.every((input, index) => input.value === sourceValues[index])
        && inputs.some((input) => input.value === value);
    });
  }, { timeout: 10_000 }, {
    sourceLine: lineNumber,
    value: before
  }).catch(async (error: unknown) => {
    const evidence = await page.evaluate(() => ({
      scrollTop: (window as any).__fullUatEditor.view.scrollDOM.scrollTop,
      tables: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')).map((table) => ({
        start: table.closest<HTMLElement>('.meo-md-html-table-shell')?.dataset.meoRenderedBlockStartLine ?? null,
        rows: Array.from(table.querySelectorAll<HTMLElement>('tr')).map((row) => ({
          line: row.dataset.sourceLineNumber ?? null,
          values: Array.from(row.querySelectorAll<HTMLTextAreaElement>('textarea'), (input) => input.value)
        }))
      }))
    }));
    throw new Error(`Missing table edit target: ${JSON.stringify({ operation, lineNumber, evidence })}`, { cause: error });
  });
  const targetAttribute = `uat-${operation.id}`;
  const initialTarget = await page.evaluate(({ sourceLine, value, target }) => {
    const editor = (window as any).__fullUatEditor;
    const sourceValues = editor.view.state.doc.line(sourceLine).text
      .trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell: string) => cell.trim());
    const row = Array.from(document.querySelectorAll<HTMLElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr'
    )).find((candidate) => {
      const inputs = Array.from(candidate.querySelectorAll<HTMLTextAreaElement>('textarea'));
      return inputs.length === sourceValues.length && inputs.every((input, index) => input.value === sourceValues[index]);
    });
    const input = Array.from(row?.querySelectorAll<HTMLTextAreaElement>('textarea') ?? [])
      .find((candidate) => candidate.value === value);
    if (!input) throw new Error(`Missing table input at line ${sourceLine}: ${value}`);
    input.dataset.uatTableTarget = target;
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerId: 777 }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, pointerId: 777 }));
    const scroller = editor.view.scrollDOM as HTMLElement;
    const viewport = scroller.getBoundingClientRect();
    const rect = input.getBoundingClientRect();
    scroller.scrollTop += rect.top + rect.height / 2 - (viewport.top + viewport.height / 2);
    return { datasetLine: Number(row?.dataset.sourceLineNumber), sourceLine };
  }, { sourceLine: lineNumber, value: before, target: targetAttribute });
  await waitForScrollStability(page);
  const clickPoint = await page.evaluate((target) => {
    const input = document.querySelector<HTMLTextAreaElement>(`[data-uat-table-target="${target}"]`);
    if (!input) throw new Error(`Missing prepared table input: ${target}`);
    const rect = input.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, targetAttribute);
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.evaluate((target) => {
    const input = document.querySelector<HTMLTextAreaElement>(`[data-uat-table-target="${target}"]`);
    if (!input) throw new Error(`Missing prepared table input: ${target}`);
    input.setSelectionRange(input.value.length, input.value.length);
  }, targetAttribute);
  await waitForScrollStability(page);
  if (initialTarget.datasetLine !== lineNumber) {
    softFindings.push({
      kind: 'stale-table-line-metadata',
      operation: operation.id,
      expectedLine: lineNumber,
      renderedLine: initialTarget.datasetLine
    });
  }
}

async function editTable(page: import('puppeteer-core').Page, operation: Operation, lineNumber: number): Promise<void> {
  const before = operation.tableCell!;
  const prepared = await page.evaluate((value) => {
    const active = document.activeElement;
    return {
      focused: active instanceof HTMLTextAreaElement,
      value: active instanceof HTMLTextAreaElement ? active.value : null,
      expected: value
    };
  }, before);
  if (!prepared.focused || prepared.value !== before) {
    throw new Error(`Prepared table input lost focus: ${JSON.stringify({ operation, prepared })}`);
  }
  await page.keyboard.type(operation.marker);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await waitForFrames(page, 10);
  const expected = `${before}${operation.marker}`;
  const state = await page.evaluate(({ sourceLine, value }) => {
    const editor = (window as any).__fullUatEditor;
    editor.commitTransientEdits();
    const active = document.activeElement;
    const sourceLineText = editor.view.state.doc.line(sourceLine).text;
    return {
      focused: active instanceof HTMLTextAreaElement,
      datasetLine: active instanceof HTMLTextAreaElement ? Number(active.closest('tr')?.dataset.sourceLineNumber) : null,
      value: active instanceof HTMLTextAreaElement ? active.value : null,
      sourceLineText
    };
  }, { sourceLine: lineNumber, value: expected });
  if (!state.sourceLineText.includes(expected) || !state.focused || state.value !== expected) {
    throw new Error(`Table edit content/focus drift: ${JSON.stringify({ operation, lineNumber, state })}`);
  }
}

async function ensureRenderedSplit(
  page: import('puppeteer-core').Page,
  kind: 'mermaid' | 'math',
  openingLine: number
): Promise<string> {
  const blockName = kind === 'mermaid' ? 'Mermaid' : 'Formula';
  const controlsLabel = `${blockName} block controls at line ${openingLine}`;
  const splitAction = kind === 'mermaid' ? 'Show Mermaid code only' : 'Show formula source only';
  await page.waitForFunction((label) => Boolean(document.querySelector(`[role="group"][aria-label="${label}"]`)), {}, controlsLabel);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await page.evaluate(({ label, splitLabel }) => {
      const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
      const button = group?.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn, .meo-latex-math-mode-btn');
      if (!button) throw new Error(`Missing rendered mode button: ${label}`);
      if (button.getAttribute('aria-label') === splitLabel) return 'split';
      button.click();
      return 'changed';
    }, { label: controlsLabel, splitLabel: splitAction });
    if (state === 'split') return controlsLabel;
    await waitForFrames(page, 8);
  }
  throw new Error(`Could not enter split mode: ${controlsLabel}`);
}

async function editRendered(
  page: import('puppeteer-core').Page,
  operation: Operation,
  openingLine: number
): Promise<void> {
  const kind = operation.kind as 'mermaid' | 'math';
  const controlsLabel = await ensureRenderedSplit(page, kind, openingLine);
  const blockName = kind === 'mermaid' ? 'Mermaid' : 'Formula';
  const regionLabel = `${blockName} editor at line ${openingLine}`;
  await page.waitForFunction((label) => Boolean(document.querySelector(`[role="region"][aria-label="${label}"] .cm-content`)), {}, regionLabel);
  await page.evaluate((label) => {
    const content = document.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"] .cm-content`);
    if (!content) throw new Error(`Missing embedded source content: ${label}`);
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.focus({ preventScroll: true });
  }, regionLabel);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`${kind === 'mermaid' ? '%% ' : '% '}${operation.marker}`);
  await page.waitForFunction((marker) => (window as any).__fullUatEditor.getText().includes(marker), {}, operation.marker);
  await waitForFrames(page, 10);
  const focus = await page.evaluate(({ label, controls }) => {
    const region = document.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`);
    return {
      focused: Boolean(region?.contains(document.activeElement)),
      controlsPresent: Boolean(document.querySelector(`[role="group"][aria-label="${controls}"]`))
    };
  }, { label: regionLabel, controls: controlsLabel });
  if (!focus.focused || !focus.controlsPresent) {
    throw new Error(`Rendered edit focus drift: ${JSON.stringify({ operation, openingLine, focus })}`);
  }
}

async function applyOperation(page: import('puppeteer-core').Page, operation: Operation): Promise<OperationRecord> {
  const beforeText = await getText(page);
  const location = await locateOperation(page, operation);
  await centerLine(page, operation.kind === 'mermaid' || operation.kind === 'math' ? location.openingLine : location.lineNumber);
  if (operation.kind === 'html') {
    await prepareHtmlSource(page, operation);
    await centerLine(page, location.lineNumber);
  }
  if (operation.kind === 'table') {
    await prepareTableInput(page, operation, location.lineNumber);
  }
  if (operation.kind === 'outer') {
    await prepareOuterSelection(page, operation);
  }
  const excludeFrom = operation.kind === 'mermaid' || operation.kind === 'math'
    ? location.openingLine
    : operation.kind === 'html'
      ? Math.max(1, location.lineNumber - 10)
    : location.lineNumber;
  const excludeTo = operation.kind === 'mermaid' || operation.kind === 'math'
    ? location.lineNumber + 8
    : operation.kind === 'html'
      ? location.lineNumber + 10
    : location.lineNumber;
  await startMonitor(page, location.lineNumber, excludeFrom, excludeTo, operation.kind === 'table');
  if (operation.kind === 'outer') await editOuter(page, operation, location.lineNumber);
  else if (operation.kind === 'html') await editHtml(page, operation, location.lineNumber);
  else if (operation.kind === 'table') await editTable(page, operation, location.lineNumber);
  else await editRendered(page, operation, location.openingLine);
  await waitForFrames(page, 8);
  const editMetrics = await stopMonitor(page);
  assertEditMetrics(operation, editMetrics);
  const afterText = await getText(page);
  if (beforeText === afterText || !afterText.includes(operation.marker)) {
    throw new Error(`Operation did not produce its marker: ${JSON.stringify(operation)}`);
  }
  return { ...operation, lineNumber: location.lineNumber, beforeText, afterText, editMetrics };
}

async function targetState(page: import('puppeteer-core').Page, operation: Operation): Promise<{
  visible: boolean;
  focused: boolean;
  scrollTop: number;
  targetTop: number | null;
  targetBottom: number | null;
  activeLineTop: number | null;
  activeLineBottom: number | null;
  cursorTop: number | null;
  cursorBottom: number | null;
  viewportTop: number;
  viewportBottom: number;
  selectionLine: number;
  visibleFromLine: number;
  visibleToLine: number;
  activeClass: string | null;
  activeAriaLabel: string | null;
  regionClass: string | null;
}> {
  const location = await locateOperation(page, operation);
  return page.evaluate(({ operationKind, lineNumber, openingLine, marker, tableCell }) => {
    const editor = (window as any).__fullUatEditor;
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    const blockName = operationKind === 'mermaid' ? 'Mermaid' : operationKind === 'math' ? 'Formula' : null;
    const region = blockName
      ? document.querySelector<HTMLElement>(`[role="region"][aria-label="${blockName} editor at line ${openingLine}"]`)
      : null;
    let tableInput: HTMLTextAreaElement | null = null;
    if (operationKind === 'table') {
      const sourceValues = editor.view.state.doc.line(lineNumber).text
        .trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell: string) => cell.trim());
      const row = Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr'
      )).find((candidate) => {
        const inputs = Array.from(candidate.querySelectorAll<HTMLTextAreaElement>('textarea'));
        return inputs.length === sourceValues.length && inputs.every((input, index) => input.value === sourceValues[index]);
      });
      tableInput = Array.from(row?.querySelectorAll<HTMLTextAreaElement>('textarea') ?? [])
        .find((input) => input.value.includes(marker) || input.value === tableCell) ?? null;
    }
    const coords = editor.view.coordsAtPos(editor.view.state.doc.line(lineNumber).from);
    const target = region ?? tableInput;
    const rect = target?.getBoundingClientRect() ?? coords;
    const active = document.activeElement;
    const activeLineRect = region?.querySelector<HTMLElement>('.cm-activeLine')?.getBoundingClientRect() ?? null;
    const cursorRect = region?.querySelector<HTMLElement>('.cm-cursor-primary')?.getBoundingClientRect() ?? null;
    const focused = operationKind === 'table'
      ? Boolean(tableInput && active === tableInput)
      : blockName
        ? Boolean(region?.contains(active))
        : editor.view.hasFocus && editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number === lineNumber;
    return {
      visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom),
      focused,
      scrollTop: editor.view.scrollDOM.scrollTop,
      targetTop: rect?.top ?? null,
      targetBottom: rect?.bottom ?? null,
      activeLineTop: activeLineRect?.top ?? null,
      activeLineBottom: activeLineRect?.bottom ?? null,
      cursorTop: cursorRect?.top ?? null,
      cursorBottom: cursorRect?.bottom ?? null,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
      visibleFromLine: editor.view.state.doc.lineAt(editor.view.viewport.from).number,
      visibleToLine: editor.view.state.doc.lineAt(editor.view.viewport.to).number,
      activeClass: active instanceof HTMLElement ? active.className : null,
      activeAriaLabel: active instanceof HTMLElement ? active.getAttribute('aria-label') : null,
      regionClass: region?.className ?? null
    };
  }, {
    operationKind: operation.kind,
    lineNumber: location.lineNumber,
    openingLine: location.openingLine,
    marker: operation.marker,
    tableCell: operation.tableCell ?? ''
  });
}

async function prepareHistoryViewport(
  page: import('puppeteer-core').Page,
  operation: Operation,
  shouldBeVisible: boolean
): Promise<ReturnType<typeof targetState> extends Promise<infer T> ? T : never> {
  const location = await locateOperation(page, operation);
  if (shouldBeVisible) {
    await centerLine(page, operation.kind === 'mermaid' || operation.kind === 'math' ? location.openingLine : location.lineNumber);
  } else {
    const totalLines = await page.evaluate(() => (window as any).__fullUatEditor.view.state.doc.lines as number);
    const opposite = location.lineNumber < totalLines / 2 ? totalLines : 1;
    await centerLine(page, opposite);
  }
  // Reading the rendered target can cause CodeMirror to materialize and measure
  // a table widget. Establish the history baseline only after that measurement
  // has stopped correcting the test's own navigation.
  await targetState(page, operation);
  await waitForScrollStability(page);
  return targetState(page, operation);
}

async function replayHistory(
  page: import('puppeteer-core').Page,
  direction: 'undo' | 'redo',
  expectedText: string,
  operation: Operation,
  shouldBeVisible: boolean,
  ordinal: number
): Promise<void> {
  const operationEvidence = {
    id: operation.id,
    kind: operation.kind,
    needle: operation.needle,
    marker: operation.marker,
    tableCell: operation.tableCell
  };
  const before = await prepareHistoryViewport(page, operation, shouldBeVisible);
  const location = await locateOperation(page, operation);
  const excludeFrom = operation.kind === 'mermaid' || operation.kind === 'math'
    ? location.openingLine
    : operation.kind === 'html'
      ? Math.max(1, location.lineNumber - 10)
    : location.lineNumber;
  const excludeTo = operation.kind === 'html' ? location.lineNumber + 10 : location.lineNumber + 8;
  await startMonitor(page, location.lineNumber, excludeFrom, excludeTo);
  const applied = await page.evaluate(async (command) => (window as any).__fullUatEditor[command](), direction);
  if (!applied) throw new Error(`${direction} was not applied at step ${ordinal}: ${operation.id}`);
  await waitForText(page, expectedText);
  await waitForFrames(page, 12);
  const metrics = await stopMonitor(page);
  const after = await targetState(page, operation);
  if (!after.visible || !after.focused) {
    throw new Error(`History target focus/visibility failure: ${JSON.stringify({ direction, ordinal, operation: operationEvidence, before, after, metrics })}`);
  }
  if (shouldBeVisible) {
    if (Math.abs(after.scrollTop - before.scrollTop) > 2 || metrics.scrollSpan > 2) {
      if (operation.kind === 'table') {
        softFindings.push({
          kind: 'visible-table-history-viewport-movement',
          direction,
          ordinal,
          operation: operation.id,
          scrollDelta: after.scrollTop - before.scrollTop,
          targetTopDelta: after.targetTop !== null && before.targetTop !== null
            ? after.targetTop - before.targetTop
            : null,
          sampledScrollSpan: metrics.scrollSpan,
          transitions: metrics.transitions
        });
      } else {
        throw new Error(`Visible history target moved unexpectedly: ${JSON.stringify({ direction, ordinal, operation: operationEvidence, before, after, metrics })}`);
      }
    }
  } else if (Math.abs(after.scrollTop - before.scrollTop) < 20) {
    throw new Error(`Offscreen history target was not revealed: ${JSON.stringify({ direction, ordinal, operation: operationEvidence, before, after, metrics })}`);
  }
  if (metrics.unrelatedLineFlashCount > 0) {
    throw new Error(`History caused unrelated rendered-line flicker: ${JSON.stringify({ direction, ordinal, operation: operationEvidence, metrics })}`);
  }
}

async function runFastHistoryCycle(
  page: import('puppeteer-core').Page,
  records: readonly OperationRecord[],
  versions: readonly string[]
): Promise<void> {
  const runApiHistory = async (direction: 'undo' | 'redo', operation: OperationRecord) => {
    const result = await page.evaluate(async (command) => {
      const editor = (window as any).__fullUatEditor;
      let timer = 0;
      const timeout = new Promise<{ status: 'timeout'; diagnostics: unknown }>((resolve) => {
        timer = window.setTimeout(() => {
          const active = document.activeElement as HTMLElement | null;
          resolve({
            status: 'timeout',
            diagnostics: {
              selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
              visibleFromLine: editor.view.state.doc.lineAt(editor.view.viewport.from).number,
              visibleToLine: editor.view.state.doc.lineAt(editor.view.viewport.to).number,
              scrollTop: editor.view.scrollDOM.scrollTop,
              activeRegion: active?.closest('[role="region"]')?.getAttribute('aria-label') ?? null,
              activeClass: active?.className ?? null,
              history: editor.getHistoryDepth(),
              renderedEditors: Array.from(document.querySelectorAll<HTMLElement>(
                '.meo-mermaid-editing-block, .meo-latex-math-editing-block'
              )).map((root) => ({
                ariaLabel: root.getAttribute('aria-label'),
                className: root.className,
                anchor: root.dataset.meoMermaidAnchor ?? root.dataset.meoLatexMathAnchor ?? null,
                top: root.getBoundingClientRect().top,
                bottom: root.getBoundingClientRect().bottom
              }))
            }
          });
        }, 3000);
      });
      const completion = Promise.resolve(editor[command]()).then((applied: boolean) => ({
        status: 'done' as const,
        applied
      }));
      const settled = await Promise.race([completion, timeout]);
      window.clearTimeout(timer);
      return settled;
    }, direction);
    if (result.status === 'timeout') {
      throw new Error(`Fast ${direction} interaction restore timed out for ${operation.id}: ${JSON.stringify(result.diagnostics)}`);
    }
    return result.applied;
  };
  for (let index = records.length - 1; index >= 0; index -= 1) {
    console.log(`fast undo ${records.length - index}/${records.length}: ${records[index]!.id}`);
    if (index % 3 === 0) {
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
    } else {
      const applied = await runApiHistory('undo', records[index]!);
      if (!applied) throw new Error(`Fast undo was not applied: ${records[index]!.id}`);
    }
    try {
      await waitForText(page, versions[index]!);
    } catch (error) {
      const actual = await getText(page);
      throw new Error(`Fast undo did not settle at ${index + 1}/${records.length} (${records[index]!.id}); expected ${versions[index]!.length} chars, received ${actual.length}`, { cause: error });
    }
  }
  for (let index = 0; index < records.length; index += 1) {
    console.log(`fast redo ${index + 1}/${records.length}: ${records[index]!.id}`);
    if (index % 3 === 0) {
      await page.keyboard.down('Control');
      await page.keyboard.press('y');
      await page.keyboard.up('Control');
    } else {
      const applied = await runApiHistory('redo', records[index]!);
      if (!applied) throw new Error(`Fast redo was not applied: ${records[index]!.id}`);
    }
    try {
      await waitForText(page, versions[index + 1]!);
    } catch (error) {
      const actual = await getText(page);
      const state = await page.evaluate(() => {
        const editor = (window as any).__fullUatEditor;
        const active = document.activeElement;
        return {
          activeConnected: active instanceof Element ? active.isConnected : null,
          activeClass: active instanceof HTMLElement ? active.className : null,
          activeTag: active?.nodeName ?? null,
          editorFocused: editor.hasFocus(),
          history: editor.getHistoryDepth()
        };
      });
      throw new Error(`Fast redo did not settle at ${index + 1}/${records.length} (${records[index]!.id}); expected ${versions[index + 1]!.length} chars, received ${actual.length}; state=${JSON.stringify(state)}`, { cause: error });
    }
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__fullUatEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, baselineText);
    await page.waitForFunction(() => Boolean((window as any).__fullUatEditor?.getText()));

    const allOperations = [...topDownOperations, ...deterministicShuffle(shuffledWave)];
    const phase = process.env.MEO_UAT_ENDURANCE_PHASE?.trim() || 'full';
    const historyTableVisibleIds = [
      'frontmatter',
      'table-3-last',
      'shuffle-table-3',
      'shuffle-code',
      'shuffle-number',
      'shuffle-footnote',
      'shuffle-mixed-format'
    ];
    const operations = phase === 'history-table-visible'
      ? historyTableVisibleIds.map((id) => {
          const operation = allOperations.find((candidate) => candidate.id === id);
          if (!operation) throw new Error(`Missing history-table-visible operation: ${id}`);
          return operation;
        })
      : phase === 'non-table'
      ? allOperations.filter((operation) => operation.kind !== 'table')
      : phase === 'table-mixed'
        ? allOperations.filter((operation) => operation.kind !== 'mermaid' && operation.kind !== 'math')
        : allOperations;
    const configuredLimit = Number.parseInt(process.env.MEO_UAT_ENDURANCE_LIMIT ?? '', 10);
    const selectedOperations = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? operations.slice(0, configuredLimit)
      : operations;
    const records: OperationRecord[] = [];
    const versions = [baselineText];
    for (const operation of selectedOperations) {
      const record = await applyOperation(page, operation);
      records.push(record);
      versions.push(record.afterText);
      console.log(`edit ${records.length}/${selectedOperations.length}: ${operation.id}`);
    }

    if (phase !== 'fast-only') {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        await replayHistory(page, 'undo', versions[index]!, records[index]!, index % 2 === 0, records.length - index);
        console.log(`undo ${records.length - index}/${records.length}: ${records[index]!.id}`);
      }
      for (let index = 0; index < records.length; index += 1) {
        await replayHistory(page, 'redo', versions[index + 1]!, records[index]!, index % 2 === 1, index + 1);
        console.log(`redo ${index + 1}/${records.length}: ${records[index]!.id}`);
      }
    }
    await runFastHistoryCycle(page, records, versions);

    const finalText = await getText(page);
    if (finalText !== versions.at(-1)) throw new Error('Final text differs after the fast history cycle');
    const aggregate = records.reduce((summary, record) => ({
      maxEditScrollSpan: Math.max(summary.maxEditScrollSpan, record.editMetrics.scrollSpan),
      maxEditTargetTopSpan: Math.max(summary.maxEditTargetTopSpan, record.editMetrics.targetTopSpan),
      editSamples: summary.editSamples + record.editMetrics.sampleCount
    }), { maxEditScrollSpan: 0, maxEditTargetTopSpan: 0, editSamples: 0 });
    const strictFinding = process.env.MEO_UAT_STRICT_FINDING?.trim();
    const strictMatches = strictFinding
      ? strictFinding === '*'
        ? softFindings
        : softFindings.filter((finding) => finding.kind === strictFinding)
      : [];
    if (strictMatches.length) {
      throw new Error(`Strict UAT finding detected: ${JSON.stringify(strictMatches)}`);
    }
    console.log(`Full UAT endurance passed: ${JSON.stringify({
      documentLines: baselineText.split('\n').length,
      phase,
      edits: records.length,
      checkedHistoryCommands: records.length * 4,
      softFindings,
      ...aggregate
    })}`);
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
