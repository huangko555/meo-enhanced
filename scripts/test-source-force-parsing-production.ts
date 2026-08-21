import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { syntaxParsingBuildPlugin } from './test-editor-syntax-parsing-build';

type ParseCall = {
  kind: 'ensure' | 'force';
  phase: string;
  docLength: number;
  viewportFrom?: number;
  viewportTo?: number;
  upto: number;
  timeout: number;
  result: 'tree' | 'complete' | 'partial';
  duration: number;
};

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-force-parsing-production-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-syntax-parsing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [syntaxParsingBuildPlugin()]
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).__meoSyntaxParseControls = { ensure: 'delegate', force: 'delegate' };
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'initial-source-production';
    });

    const targetLine = 1_401;
    const remoteParagraphCount = 6_500;
    const remoteSyntax = [
      '| Remote Real A | Remote Real B |',
      '| --- | --- |',
      '| one | two |',
      'paragraph with #remote-valid-tag',
      '```text',
      '| Remote Fake A | Remote Fake B |',
      '| :--- | ---: |',
      '#remote-not-a-tag',
      'const remoteInsideFence = true',
      '```'
    ];
    const documentText = [
      '# Large Source trace',
      '',
      ...Array.from({ length: remoteParagraphCount }, (_, index) => (
        index === targetLine - 3
          ? `## Visible target ${index} with ==trace-highlight==`
          : `paragraph ${index} with **Markdown** content and stable text`
      )),
      '',
      '## OFFSCREEN FINAL SYNTAX',
      '',
      ...remoteSyntax
    ].join('\n');
    assert.ok(documentText.length > 347_000, 'production trace must exceed the reviewed 347k Source document');

    const initial = await page.evaluate((text) => {
      const harness = (window as any).EditorSyntaxParsingHarness;
      const editor = harness.createEditor({
        parent: document.getElementById('app'),
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
      (window as any).__sourceForceParsingEditor = editor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    }, documentText);
    assert.equal(initial.mode, 'source');
    assert.equal(initial.text, documentText);
    assert.deepEqual(initial.history, { undo: 0, redo: 0 });
    assert.deepEqual(initial.calls, [], 'production initial Source must not request a synchronous full parse');

    const remoteFakeHeaderPosition = documentText.indexOf('| Remote Fake A | Remote Fake B |');
    const remoteSyntaxLine = remoteParagraphCount + 6;
    const assertRemotePublication = async (expectedText: string, label: string): Promise<void> => {
      await page.evaluate(({ line, position }) => {
        const editor = (window as any).__sourceForceParsingEditor;
        editor.scrollToLine(line, 'top');
        editor.revealSelection(position, position, { focusEditor: true, align: 'nearest' });
        editor.focus();
      }, { line: remoteSyntaxLine, position: remoteFakeHeaderPosition });
      await waitForFrames(page, 2);
      const beforePublication = await page.evaluate(() => {
        const editor = (window as any).__sourceForceParsingEditor;
        return {
          text: editor.getText(),
          selection: editor.view.state.selection.main.head,
          history: editor.getHistoryDepth(),
          focused: editor.hasFocus(),
          viewport: editor.getTopVisiblePosition()
        };
      });
      await page.waitForFunction((position) => {
        const harness = (window as any).EditorSyntaxParsingHarness;
        const editor = (window as any).__sourceForceParsingEditor;
        const names = harness.publishedNodeNamesAt(editor, position);
        return names.includes('CodeText') && names.includes('FencedCode');
      }, {}, remoteFakeHeaderPosition);
      await waitForFrames(page, 4);

      const result = await page.evaluate(() => {
        const lines = Array.from(document.querySelectorAll<HTMLElement>('#app .cm-line'));
        const summarize = (text: string) => {
          const line = lines.find((candidate) => candidate.textContent === text) ?? null;
          return {
            visible: Boolean(line),
            tableLine: line?.classList.contains('meo-md-source-table-header-line') ?? false,
            tableCells: line?.querySelectorAll('.meo-md-source-table-header-cell').length ?? 0,
            codeLine: line?.classList.contains('meo-src-code-block') ?? false,
            tags: line?.querySelectorAll('.meo-md-tag').length ?? 0
          };
        };
        const editor = (window as any).__sourceForceParsingEditor;
        return {
          realHeader: summarize('| Remote Real A | Remote Real B |'),
          validTag: summarize('paragraph with #remote-valid-tag'),
          fenceStart: summarize('```text'),
          fakeHeader: summarize('| Remote Fake A | Remote Fake B |'),
          fakeDelimiter: summarize('| :--- | ---: |'),
          fakeTag: summarize('#remote-not-a-tag'),
          codeText: summarize('const remoteInsideFence = true'),
          fenceEnd: summarize('```'),
          text: editor.getText(),
          selection: editor.view.state.selection.main.head,
          history: editor.getHistoryDepth(),
          focused: editor.hasFocus(),
          viewport: editor.getTopVisiblePosition(),
          calls: structuredClone((window as any).__meoSyntaxParseCalls)
        };
      });
      assert.equal(result.text, expectedText, `${label} must preserve Document text`);
      assert.equal(result.selection, remoteFakeHeaderPosition, `${label} must preserve selection`);
      assert.deepEqual(result.history, { undo: 0, redo: 0 }, `${label} must not enter Editor History`);
      assert.equal(result.focused, true, `${label} must preserve focus`);
      assert.deepEqual(
        {
          text: result.text,
          selection: result.selection,
          history: result.history,
          focused: result.focused,
          viewport: result.viewport
        },
        beforePublication,
        `${label} must preserve text, selection, history, focus and viewport while the parser publishes`
      );
      assert.deepEqual(result.calls, [], `${label} must not call ensureSyntaxTree/forceParsing`);
      assert.equal(result.realHeader.tableLine, true, `${label} must keep the legal table header`);
      assert.ok(result.realHeader.tableCells > 0, `${label} must keep legal table cells`);
      assert.equal(result.validTag.tags, 1, `${label} must keep the legal Source tag`);
      for (const [lineLabel, line] of Object.entries({
        fenceStart: result.fenceStart,
        fakeHeader: result.fakeHeader,
        fakeDelimiter: result.fakeDelimiter,
        fakeTag: result.fakeTag,
        codeText: result.codeText,
        fenceEnd: result.fenceEnd
      })) {
        assert.equal(line.visible, true, `${label} ${lineLabel} must be visible`);
        assert.equal(line.codeLine, true, `${label} ${lineLabel} must have the Source code-block line decoration`);
      }
      assert.equal(result.fakeHeader.tableLine, false, `${label} must remove the temporary fake table line`);
      assert.equal(result.fakeHeader.tableCells, 0, `${label} must remove temporary fake table cells`);
      assert.equal(result.fakeTag.tags, 0, `${label} must remove the temporary fenced Source tag`);
    };

    await assertRemotePublication(documentText, 'first parser publication');

    const externallyPresentedText = documentText.replace('paragraph 0 with', 'paragraph 0 WITH');
    await page.evaluate((text) => {
      const editor = (window as any).__sourceForceParsingEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'source-external-republication';
      editor.setText(text);
    }, externallyPresentedText);
    await assertRemotePublication(externallyPresentedText, 'repeated parser publication');

    await page.evaluate((lineNumber) => {
      const editor = (window as any).__sourceForceParsingEditor;
      editor.scrollToLine(lineNumber, 'top');
      const target = editor.getText().indexOf('trace-highlight');
      editor.revealSelection(target, target + 'trace-highlight'.length, {
        focusEditor: true,
        align: 'nearest'
      });
      editor.focus();
    }, targetLine);
    await page.waitForFunction(() => Boolean(document.querySelector('#app .meo-md-highlight')));
    await waitForFrames(page);

    const before = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      return {
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition(),
        visibleRange: editor.getVisibleDocumentRange()
      };
    });

    const sourceToLive = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'source-to-live-production';
      const startedAt = performance.now();
      editor.setMode('live');
      return {
        elapsed: performance.now() - startedAt,
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    const liveForceCalls = sourceToLive.calls.filter((call: ParseCall) => call.kind === 'force');
    assert.equal(liveForceCalls.length, 1);
    assert.deepEqual(
      liveForceCalls.map(({ upto, timeout }) => ({ upto, timeout })),
      [{ upto: documentText.length, timeout: 500 }]
    );
    assert.ok(
      sourceToLive.calls.filter((call: ParseCall) => call.kind === 'ensure').every((call) => (
        call.upto === documentText.length && call.timeout === 50
      ))
    );

    await waitForFrames(page);
    const liveState = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition()
      };
    });
    assert.equal(liveState.mode, 'live');
    assert.equal(liveState.text, before.text);
    assert.deepEqual(liveState.selection, before.selection);
    assert.deepEqual(liveState.history, before.history);
    assert.equal(liveState.focused, true);
    assert.ok(Math.abs(liveState.viewport.line - before.viewport.line) <= 1);

    const liveToSource = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      (window as any).__meoSyntaxParseCalls = [];
      (window as any).__meoSyntaxParsePhase = 'live-to-source-production';
      const startedAt = performance.now();
      editor.setMode('source');
      return {
        elapsed: performance.now() - startedAt,
        calls: structuredClone((window as any).__meoSyntaxParseCalls)
      };
    });
    assert.deepEqual(liveToSource.calls, [], 'production Live-to-Source must not force or ensure the whole document');
    await waitForFrames(page);
    const sourceState = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition()
      };
    });
    assert.equal(sourceState.mode, 'source');
    assert.equal(sourceState.text, before.text);
    assert.deepEqual(sourceState.selection, before.selection);
    assert.deepEqual(sourceState.history, before.history);
    assert.equal(sourceState.focused, true);
    assert.ok(Math.abs(sourceState.viewport.line - before.viewport.line) <= 1);

    const repeatedTraces: Array<{ direction: string; elapsed: number; calls: ParseCall[] }> = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      repeatedTraces.push(await page.evaluate((round) => {
        const editor = (window as any).__sourceForceParsingEditor;
        (window as any).__meoSyntaxParseCalls = [];
        (window as any).__meoSyntaxParsePhase = `production-round-${round}-to-live`;
        const startedAt = performance.now();
        editor.setMode('live');
        return {
          direction: 'source-to-live',
          elapsed: performance.now() - startedAt,
          calls: structuredClone((window as any).__meoSyntaxParseCalls)
        };
      }, cycle));
      await waitForFrames(page);
      repeatedTraces.push(await page.evaluate((round) => {
        const editor = (window as any).__sourceForceParsingEditor;
        (window as any).__meoSyntaxParseCalls = [];
        (window as any).__meoSyntaxParsePhase = `production-round-${round}-to-source`;
        const startedAt = performance.now();
        editor.setMode('source');
        return {
          direction: 'live-to-source',
          elapsed: performance.now() - startedAt,
          calls: structuredClone((window as any).__meoSyntaxParseCalls)
        };
      }, cycle));
      await waitForFrames(page);
    }
    for (const trace of repeatedTraces) {
      if (trace.direction === 'source-to-live') {
        assert.equal(trace.calls.filter((call) => call.kind === 'force').length, 1);
      } else {
        assert.deepEqual(trace.calls, []);
      }
    }
    await waitForFrames(page);
    const repeatedState = await page.evaluate(() => {
      const editor = (window as any).__sourceForceParsingEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-source') ? 'source' : 'live',
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        viewport: editor.getTopVisiblePosition()
      };
    });
    assert.equal(repeatedState.mode, 'source');
    assert.equal(repeatedState.text, before.text);
    assert.deepEqual(repeatedState.selection, before.selection);
    assert.deepEqual(repeatedState.history, before.history);
    assert.equal(repeatedState.focused, true);
    assert.ok(
      Math.abs(repeatedState.viewport.line - before.viewport.line) <= 1,
      `rapid round trips moved viewport from ${before.viewport.line} to ${repeatedState.viewport.line}`
    );

    console.log(JSON.stringify({
      documentLength: externallyPresentedText.length,
      documentLines: externallyPresentedText.split('\n').length,
      visibleRangeBeforeSwitch: before.visibleRange,
      sourceToLive: {
        elapsed: sourceToLive.elapsed,
        calls: sourceToLive.calls.map(({ kind, upto, timeout, result, duration }) => ({
          kind,
          upto,
          timeout,
          result,
          duration
        }))
      },
      liveToSource: {
        elapsed: liveToSource.elapsed,
        calls: liveToSource.calls
      },
      repeated: repeatedTraces.map((trace) => ({
        direction: trace.direction,
        elapsed: trace.elapsed,
        forceCalls: trace.calls.filter((call) => call.kind === 'force').length,
        ensureCalls: trace.calls.filter((call) => call.kind === 'ensure').length
      }))
    }));

    await page.evaluate(() => (window as any).__sourceForceParsingEditor.destroy());
  } finally {
    await browser.close();
  }

  console.log('Source forceParsing production Chromium trace passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
