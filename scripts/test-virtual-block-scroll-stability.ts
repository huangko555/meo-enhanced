import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-virtual-block-scroll-'));
const visibleCorrectionTolerance = 3.5;

type VisibleSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  visibleLineTops: Record<string, number>;
  documentLineTops: number[];
  mountedVirtualBlocks: string[];
  mountedVirtualBlockHeights: Record<string, number>;
  mountedTableRowHeights: Record<string, number[]>;
  mountedTableColumnWidths: Record<string, number[]>;
  mountedMermaidGeometry: Record<string, {
    containerWidth: number;
    svgWidth: number;
    svgHeight: number;
    intrinsicWidth: string | null;
    intrinsicHeight: string | null;
    viewBox: string | null;
  }>;
  mountedVirtualBlockRanges: Record<string, { start: number; end: number }>;
  visibleLoadingBlocks: string[];
  visibleIntegrityMismatches: Array<{
    kind: 'text-document' | 'gutter-document';
    text: string;
    expectedLine: number;
    actualLine: number;
  }>;
};

function createFixture(): string {
  const lines = Array.from({ length: 122 }, (_, index) => `前置稳定行 ${index + 1}`);
  lines.push(
    '# 5. HTML 块',
    '',
    '<div>',
    '<p>HTML 第一行</p>',
    '<p>HTML 第二行</p>',
    '<p>HTML 第三行</p>',
    '</div>',
    '',
    '# 6. 短代码块',
    '',
    '## 6.1 TypeScript',
    '',
    '```typescript',
    'type User = {',
    '  id: number;',
    '  name: string;',
    '};',
    '',
    "const baselineUser: User = { id: 1, name: 'Alice' };",
    'console.log(baselineUser.name);',
    '```',
    '',
    '## 6.2 JSON',
    '',
    '```json',
    '{',
    '  "name": "scroll-fixture",',
    '  "enabled": true',
    '}',
    '```',
    '',
    '# 7. 长代码块与折叠',
    '',
    '```python',
    'def long_code_baseline():'
  );
  for (let index = 1; index <= 25; index += 1) {
    lines.push(`    value_${String(index).padStart(2, '0')} = ${index}`);
  }
  lines.push(
    '    return value_01 + value_25',
    '```',
    '',
    '第二个长代码块：',
    '',
    '```javascript',
    'const rows = [];'
  );
  for (let index = 1; index <= 24; index += 1) {
    lines.push(`rows.push('row-${String(index).padStart(2, '0')}');`);
  }
  lines.push(
    "console.log(rows.join(','));",
    '```',
    '',
    '# 8. 普通内容',
    '',
    ...Array.from({ length: 18 }, (_, index) => `块间稳定行 ${index + 1}`),
    '# 9. LaTeX 公式',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    '$$',
    '',
    '# 10. Mermaid',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Baseline A] --> B{Choose}',
    '  B -->|Undo| C[Restore]',
    '  B -->|Redo| D[Reapply]',
    '  C --> E[Done]',
    '  D --> E',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant U as User',
    '  participant E as Editor',
    '  U->>E: Edit baseline',
    '  U->>E: Undo',
    '  E-->>U: Restore baseline',
    '  U->>E: Redo',
    '  E-->>U: Restore edit',
    '```',
    '',
    '# 11. 表格一',
    '',
    '| ID | 名称 | 状态 |',
    '| --- | --- | --- |',
    '| 1 | Alpha | Ready |',
    '| 2 | Bravo | Editing |',
    '| 3 | Charlie | Done |',
    '',
    '# 12. 表格二',
    '',
    '| 左对齐说明 | 居中标签 | 右对齐数值 |',
    '| :--- | :---: | ---: |',
    '| 普通文字 | **Bold** | 100.25 |',
    '| [链接](https://example.com) | `inline code` | 200.50 |',
    '| ~~旧值~~ 新值 | #table/tag | 300.75 |',
    '',
    '# 13. 长表格',
    '',
    '| 行 | A 列 | B 列 | C 列 | D 列 |',
    '| ---: | --- | --- | --- | --- |'
  );
  for (let index = 1; index <= 12; index += 1) {
    const row = String(index).padStart(2, '0');
    lines.push(`| ${row} | A${row} | B${row} | C${row} | D${row} |`);
  }
  lines.push('', '# 14. 后续内容', ...Array.from({ length: 100 }, (_, index) => `后置稳定行 ${index + 1}`));
  return lines.join('\n');
}

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function snapshot(page: Page, collectDocumentGeometry = false): Promise<VisibleSnapshot> {
  return page.evaluate(async (shouldCollectDocumentGeometry) => {
    const editor = (window as any).__virtualBlockEditor;
    const view = editor.view;
    const scroller = view.scrollDOM as HTMLElement;
    // Force any pending layout now, then sample after CodeMirror has completed
    // the next paintable frame. The intermediate synchronous layout state is
    // not a user-visible scroll position.
    void scroller.scrollHeight;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const viewport = scroller.getBoundingClientRect();
    const visibleLineTops: Record<string, number> = {};
    const sourceLineNumbers = new Map<string, number | null>();
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      const text = view.state.doc.line(lineNumber).text.trim();
      if (!text) continue;
      sourceLineNumbers.set(text, sourceLineNumbers.has(text) ? null : lineNumber);
    }
    const gutters = Array.from(
      view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
    ).map((element) => ({
      line: Number(element.textContent?.trim()),
      rect: element.getBoundingClientRect()
    })).filter((item) => Number.isFinite(item.line));
    const visibleIntegrityMismatches: VisibleSnapshot['visibleIntegrityMismatches'] = [];
    for (const lineElement of view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')) {
      const rect = lineElement.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      try {
        const position = view.posAtDOM(lineElement, 0);
        const line = view.state.doc.lineAt(position).number;
        visibleLineTops[String(line)] = rect.top;
        const text = lineElement.innerText.trim();
        const expectedTextLine = sourceLineNumbers.get(text);
        if (expectedTextLine && expectedTextLine !== line) {
          visibleIntegrityMismatches.push({
            kind: 'text-document', text, expectedLine: expectedTextLine, actualLine: line
          });
        }
        const center = rect.top + rect.height / 2;
        const gutter = gutters.reduce<typeof gutters[number] | null>((closest, item) => {
          if (!closest) return item;
          const distance = Math.abs(item.rect.top + item.rect.height / 2 - center);
          const closestDistance = Math.abs(closest.rect.top + closest.rect.height / 2 - center);
          return distance < closestDistance ? item : closest;
        }, null);
        if (gutter && Math.abs(gutter.line - line) > 3) {
          visibleIntegrityMismatches.push({
            kind: 'gutter-document', text, expectedLine: line, actualLine: gutter.line
          });
        }
      } catch {
        // Ignore transient nodes that CodeMirror has already detached.
      }
    }
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      visibleLineTops,
      visibleIntegrityMismatches,
      documentLineTops: shouldCollectDocumentGeometry
        ? Array.from({ length: view.state.doc.lines }, (_, index) => (
            view.lineBlockAt(view.state.doc.line(index + 1).from).top
          ))
        : [],
      visibleLoadingBlocks: Array.from(
        document.querySelectorAll<HTMLElement>('.meo-mermaid-block:has(.meo-mermaid-loading)')
      ).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }).map((element) => element.dataset.meoRenderedBlockStartLine ?? 'unknown'),
      ...(() => {
        const mountedVirtualBlockHeights: Record<string, number> = {};
          const mountedTableRowHeights: Record<string, number[]> = {};
          const mountedTableColumnWidths: Record<string, number[]> = {};
        const mountedMermaidGeometry: VisibleSnapshot['mountedMermaidGeometry'] = {};
        const mountedVirtualBlockRanges: Record<string, { start: number; end: number }> = {};
        for (const element of document.querySelectorAll<HTMLElement>(
          '.meo-md-long-code-placeholder,.meo-md-long-code-footer,.meo-mermaid-block,.meo-md-math-fenced-display,.meo-md-html-table-shell,.meo-md-html-block'
        )) {
          const key = [
            element.dataset.meoRenderedBlockKind ?? element.className,
            element.dataset.meoRenderedBlockStartLine ?? element.dataset.longCodeAnchor ?? ''
          ].join(':');
          mountedVirtualBlockHeights[key] = element.getBoundingClientRect().height;
          const start = Number(element.dataset.meoRenderedBlockStartLine ?? 0);
          const end = Number(element.dataset.meoRenderedBlockEndLine ?? start);
          mountedVirtualBlockRanges[key] = {
            start: Number.isFinite(start) && start > 0 ? start : 1,
            end: Number.isFinite(end) && end >= start ? end : start
          };
          if (element.classList.contains('meo-md-html-table-shell')) {
            mountedTableRowHeights[key] = Array.from(
              element.querySelectorAll<HTMLTableRowElement>('.meo-md-html-table > thead > tr, .meo-md-html-table > tbody > tr'),
              (row) => row.getBoundingClientRect().height
            );
            mountedTableColumnWidths[key] = Array.from(
              element.querySelectorAll<HTMLElement>('.meo-md-html-table > thead > tr:first-child > th'),
              (cell) => cell.getBoundingClientRect().width
            );
          }
          if (element.classList.contains('meo-mermaid-block')) {
            const svg = element.querySelector<SVGSVGElement>('svg');
            const rect = svg?.getBoundingClientRect();
            mountedMermaidGeometry[key] = {
              containerWidth: element.getBoundingClientRect().width,
              svgWidth: rect?.width ?? 0,
              svgHeight: rect?.height ?? 0,
              intrinsicWidth: svg?.getAttribute('width') ?? null,
              intrinsicHeight: svg?.getAttribute('height') ?? null,
              viewBox: svg?.getAttribute('viewBox') ?? null
            };
          }
        }
        return {
          mountedVirtualBlocks: Object.keys(mountedVirtualBlockHeights).sort(),
          mountedVirtualBlockHeights,
          mountedTableRowHeights,
          mountedTableColumnWidths,
          mountedMermaidGeometry,
          mountedVirtualBlockRanges
        };
      })()
    };
  }, collectDocumentGeometry);
}

async function main(): Promise<void> {
  const documentArgument = process.argv.find((argument) => argument.startsWith('--document='));
  const source = documentArgument
    ? fs.readFileSync(documentArgument.slice('--document='.length), 'utf8')
    : createFixture();
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-virtual-block-scroll-stability-entry.ts')],
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
    await page.setViewport({ width: 1120, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-inset-background:#20252a;--meo-semantic-mutedForeground:#8b949e;--meo-semantic-tableBorder:#3e444d;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__virtualBlockEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await page.waitForSelector('.cm-scroller');
    await waitForFrames(page, 8);
    const integrityStress = process.argv.includes('--integrity-stress');
    if (integrityStress) {
      const assertIntegrity = async (step: string, failOnMismatch = true): Promise<void> => {
        const result = await page.evaluate(() => {
          const editor = (window as any).__virtualBlockEditor;
          const view = editor.view;
          const viewport = view.scrollDOM.getBoundingClientRect();
          const sourceLineNumbers = new Map<string, number | null>();
          for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
            const text = view.state.doc.line(lineNumber).text.trim();
            if (!text) continue;
            sourceLineNumbers.set(text, sourceLineNumbers.has(text) ? null : lineNumber);
          }
          const gutters = Array.from(
            view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
          ).map((element) => ({
            number: Number(element.textContent?.trim()),
            rect: element.getBoundingClientRect()
          })).filter((item) => Number.isFinite(item.number));
          const mismatches: Array<Record<string, unknown>> = [];
          for (const element of view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')) {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
            let documentLine: number;
            try {
              documentLine = view.state.doc.lineAt(view.posAtDOM(element, 0)).number;
            } catch {
              continue;
            }
            const text = element.innerText.trim();
            const expectedTextLine = sourceLineNumbers.get(text);
            const center = rect.top + rect.height / 2;
            const gutter = gutters.reduce<typeof gutters[number] | null>((closest, item) => {
              const itemCenter = item.rect.top + item.rect.height / 2;
              if (!closest) return item;
              const closestCenter = closest.rect.top + closest.rect.height / 2;
              return Math.abs(itemCenter - center) < Math.abs(closestCenter - center) ? item : closest;
            }, null);
            if (expectedTextLine && expectedTextLine !== documentLine) {
              mismatches.push({ kind: 'text-document', text, expectedTextLine, documentLine });
            }
            if (gutter && Math.abs((gutter.rect.top + gutter.rect.height / 2) - center) <= rect.height
              && gutter.number !== documentLine) {
              mismatches.push({ kind: 'gutter-document', text, gutterLine: gutter.number, documentLine });
            }
          }
          return {
            mismatches,
            scrollTop: view.scrollDOM.scrollTop,
            visibleText: Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.bottom > viewport.top && rect.top < viewport.bottom;
              })
              .map((element) => element.innerText.trim()).filter(Boolean).slice(0, 12)
          };
        });
        if (result.mismatches.length > 0 && failOnMismatch) {
          throw new Error(`Live viewport content integrity failed at ${step}: ${JSON.stringify(result)}`);
        }
        if (result.mismatches.length > 0) {
          console.warn(`Transient live viewport mismatch at ${step}: ${JSON.stringify(result)}`);
        }
      };
      const documentLineCount = await page.evaluate(() => (
        (window as any).__virtualBlockEditor.view.state.doc.lines
      ));
      await page.evaluate(() => {
        (window as any).__virtualBlockEditor.scrollToLine(38, 'center');
      });
      await waitForFrames(page, 3);
      const inputPoint = await page.evaluate(() => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((element) => element.innerText.includes('1.1 空行与多行编辑'));
        if (!line) throw new Error('Could not find the near-document input line');
        const rect = line.getBoundingClientRect();
        return { x: rect.right - 4, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(inputPoint.x, inputPoint.y);
      await page.keyboard.press('End');
      await page.keyboard.type('x');
      await page.evaluate(() => {
        (window as any).__virtualBlockEditor.scrollToLine(340, 'top');
      });
      await waitForFrames(page, 1);
      await assertIntegrity('post-input-far-jump-frame-1', false);
      await waitForFrames(page, 7);
      await assertIntegrity('post-input-far-jump-settled');
      const targets = [284, documentLineCount, 340, 1, 284, documentLineCount, 284];
      for (const [index, target] of targets.entries()) {
        await page.evaluate((lineNumber) => {
          (window as any).__virtualBlockEditor.scrollToLine(lineNumber, 'top');
        }, Math.min(target, documentLineCount));
        await waitForFrames(page, 1);
        await assertIntegrity(`jump-${index}-frame-1`, false);
        await waitForFrames(page, 7);
        await assertIntegrity(`jump-${index}-settled`);
        await page.mouse.move(720, 480);
        await page.mouse.wheel({ deltaY: index % 2 === 0 ? 360 : -360 });
        await waitForFrames(page, 1);
        await assertIntegrity(`wheel-${index}-frame-1`, false);
        await waitForFrames(page, 4);
        await assertIntegrity(`wheel-${index}-settled`);
        if (index % 2 === 1) {
          await page.evaluate(() => {
            (window as any).__virtualBlockEditor.setMode('source');
          });
          await waitForFrames(page, 2);
          await page.evaluate(() => {
            (window as any).__virtualBlockEditor.setMode('live');
          });
          await waitForFrames(page, 1);
          await assertIntegrity(`mode-roundtrip-${index}-frame-1`, false);
          await waitForFrames(page, 7);
          await assertIntegrity(`mode-roundtrip-${index}-settled`);
        }
      }
      console.log('live viewport content integrity stress test passed');
      return;
    }
    const diagnosticMode = process.argv.includes('--diagnostic');
    const reverseAfterJump = process.argv.includes('--reverse-after-jump');
    const continuousWheel = process.argv.includes('--continuous-wheel');
    if (reverseAfterJump) {
      await page.evaluate(() => {
        const editor = (window as any).__virtualBlockEditor;
        editor.scrollToLine(editor.view.state.doc.lines, 'top');
      });
      await waitForFrames(page, 8);
    }
    if (diagnosticMode) {
      console.log('height estimates', await page.evaluate(() => ({
        longCode: (window as any).BlockWidgetHeightHarness.estimate({ kind: 'long-code-control' }),
        flowchart: (window as any).BlockWidgetHeightHarness.estimate({
          kind: 'mermaid-preview',
          source: 'flowchart LR\nA --> B\nB --> C\nB --> D\nC --> E\nD --> E',
          displayMath: false
        }),
        sequence: (window as any).BlockWidgetHeightHarness.estimate({
          kind: 'mermaid-preview',
          source: 'sequenceDiagram\nparticipant U\nparticipant E\nU->>E: Edit\nU->>E: Undo\nE-->>U: Restore\nU->>E: Redo\nE-->>U: Restore',
          displayMath: false
        }),
        longTable: (window as any).BlockWidgetHeightHarness.estimate({
          kind: 'table',
          headerCells: ['行', 'A 列', 'B 列', 'C 列', 'D 列'],
          rows: Array.from({ length: 12 }, (_, index) => {
            const row = String(index + 1).padStart(2, '0');
            return [row, `A${row}`, `B${row}`, `C${row}`, `D${row}`];
          })
        }),
        contentFont: getComputedStyle(document.querySelector('.cm-content')!).fontSize,
        contentLineHeight: getComputedStyle(document.querySelector('.cm-content')!).lineHeight,
        editorFont: getComputedStyle(document.querySelector('.cm-editor')!).fontSize
      })));
    }
    await page.mouse.move(720, 480);
    if (diagnosticMode) {
      await page.evaluate(() => {
        const scroller = (window as any).__virtualBlockEditor.view.scrollDOM as HTMLElement;
        const trace: Array<{ event: string; scrollTop: number; time: number }> = [];
        (window as any).__virtualBlockWheelTrace = trace;
        scroller.addEventListener('wheel', () => {
          trace.push({ event: 'wheel', scrollTop: scroller.scrollTop, time: performance.now() });
        }, { capture: true, passive: true });
        scroller.addEventListener('scroll', () => {
          trace.push({ event: 'scroll', scrollTop: scroller.scrollTop, time: performance.now() });
        }, { capture: true, passive: true });
      });
    }

    const corrections: Array<{
      step: number;
      line: number;
      correction: number;
      beforeTop: number;
      afterTop: number;
      beforeScrollTop: number;
      afterScrollTop: number;
      beforeScrollHeight: number;
      afterScrollHeight: number;
    }> = [];
    const heightChanges: Array<{ step: number; before: number; after: number }> = [];
    const documentGeometryChanges: Array<{
    step: number;
    line: number;
    delta: number;
    mounted: Record<string, number | number[] | VisibleSnapshot['mountedMermaidGeometry'][string]>;
    }> = [];
    const mountMeasurements: Array<{
      step: number;
      line: number;
      block: string;
      geometryDelta: number;
      measuredHeight: number;
      inferredEstimate: number;
      columnWidths?: number[];
    }> = [];
    const loadingObservations: Array<{ step: number; lines: string[] }> = [];
    const maxSteps = continuousWheel ? 240 : reverseAfterJump ? 260 : 180;
    const wheelDelta = reverseAfterJump
      ? continuousWheel ? -72 : -180
      : continuousWheel ? 48 : 100;
    for (let step = 0; step < maxSteps; step += 1) {
      const before = await snapshot(page, diagnosticMode);
      await page.mouse.wheel({ deltaY: wheelDelta });
      await waitForFrames(page, continuousWheel ? 1 : 3);
      if (diagnosticMode) {
        await page.evaluate(() => {
          const scroller = (window as any).__virtualBlockEditor.view.scrollDOM as HTMLElement;
          (window as any).__virtualBlockWheelTrace.push({
            event: 'snapshot',
            scrollTop: scroller.scrollTop,
            time: performance.now()
          });
        });
      }
      const after = await snapshot(page, diagnosticMode);
      if (after.visibleIntegrityMismatches.length > 0) {
        throw new Error(
          `Virtual viewport rendered mismatched document content at step ${step}: ` +
          JSON.stringify(after.visibleIntegrityMismatches.slice(0, 12))
        );
      }
      const scrollDelta = after.scrollTop - before.scrollTop;
      if (Math.abs(scrollDelta) < 1) break;
      if (after.visibleLoadingBlocks.length > 0) {
        loadingObservations.push({ step, lines: after.visibleLoadingBlocks });
      }
      if (Math.abs(after.scrollHeight - before.scrollHeight) > 1) {
        heightChanges.push({ step, before: before.scrollHeight, after: after.scrollHeight });
      }
      const mountedBefore = new Set(before.mountedVirtualBlocks);
      const mountedNewBlocks = after.mountedVirtualBlocks.filter((block) => !mountedBefore.has(block));
      for (const block of diagnosticMode ? mountedNewBlocks : []) {
        const range = after.mountedVirtualBlockRanges[block]!;
        const beforeLineIndex = Math.max(0, range.start - 2);
        const afterLineIndex = Math.min(before.documentLineTops.length - 1, range.end);
        const upstreamDelta = after.documentLineTops[beforeLineIndex]! - before.documentLineTops[beforeLineIndex]!;
        const downstreamDelta = after.documentLineTops[afterLineIndex]! - before.documentLineTops[afterLineIndex]!;
        const delta = downstreamDelta - upstreamDelta;
        const measuredHeight = after.mountedVirtualBlockHeights[block] ?? 0;
        mountMeasurements.push({
          step,
          line: range.start,
          block,
          geometryDelta: delta,
          measuredHeight,
          inferredEstimate: measuredHeight - delta,
          columnWidths: after.mountedTableColumnWidths[block]
        });
        if (Math.abs(delta) > 8) {
          documentGeometryChanges.push({
            step,
            line: range.start,
            delta,
            mounted: {
              [block]: after.mountedTableRowHeights[block]
                ?? after.mountedMermaidGeometry[block]
                ?? after.mountedVirtualBlockHeights[block]
                ?? 0
            }
          });
        }
      }
      for (const [line, beforeTop] of Object.entries(before.visibleLineTops)) {
        const afterTop = after.visibleLineTops[line];
        if (afterTop === undefined) continue;
        const maximumBeforeScrollTop = Math.max(0, before.scrollHeight - before.clientHeight);
        const intendedScrollDelta = Math.max(
          -before.scrollTop,
          Math.min(wheelDelta, maximumBeforeScrollTop - before.scrollTop)
        );
        // Reading stabilization may change scrollTop by the exact amount of a
        // late height-map correction. Judge what the user saw against the
        // original wheel intent instead of treating that compensation as an
        // extra scroll.
        const correction = afterTop - beforeTop + intendedScrollDelta;
        if (Math.abs(correction) > visibleCorrectionTolerance) {
          corrections.push({
            step,
            line: Number(line),
            correction,
            beforeTop,
            afterTop,
            beforeScrollTop: before.scrollTop,
            afterScrollTop: after.scrollTop,
            beforeScrollHeight: before.scrollHeight,
            afterScrollHeight: after.scrollHeight
          });
        }
      }
    }

    if (diagnosticMode) {
      console.log(JSON.stringify({
        direction: reverseAfterJump ? 'reverse-after-jump' : 'forward',
        heightChanges,
        documentGeometryChanges,
        mountMeasurements,
        loadingObservations,
        wheelTrace: await page.evaluate(() => (window as any).__virtualBlockWheelTrace.slice(-30)),
        tableDetails: await page.evaluate(() => Array.from(
          document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')
        ).map((shell) => ({
          line: shell.dataset.meoRenderedBlockStartLine,
          rows: Array.from(shell.querySelectorAll<HTMLTableRowElement>(
            ':scope > .meo-md-html-table-wrap > .meo-md-html-table > tbody > tr'
          )).map((row) => Array.from(row.cells, (cell) => {
            const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
            return {
              cellHeight: cell.getBoundingClientRect().height,
              cellWidth: cell.getBoundingClientRect().width,
              previewHeight: preview?.getBoundingClientRect().height,
              previewScrollHeight: preview?.scrollHeight,
              text: preview?.textContent
            };
          }))
        })))
      }, null, 2));
    }
    if (corrections.length > 0) {
      throw new Error(`Virtual block mounting shifted visible document content: ${JSON.stringify(corrections.slice(0, 12))}`);
    }
    if (loadingObservations.length > 3) {
      throw new Error(`Reverse reading exposed Mermaid loading for multiple frames: ${JSON.stringify(loadingObservations.slice(0, 12))}`);
    }
    console.log('virtual block scroll stability browser test passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
