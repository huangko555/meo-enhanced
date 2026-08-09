import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-presentation-production-'));

async function main(): Promise<void> {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'webview/src/index.ts'), 'utf8');
  const editorSource = fs.readFileSync(path.join(repoRoot, 'webview/src/editor.ts'), 'utf8');
  const widgetSource = fs.readFileSync(
    path.join(repoRoot, 'webview/src/helpers/mermaidDiagram.ts'),
    'utf8'
  );
  const previewSource = fs.readFileSync(
    path.join(repoRoot, 'webview/src/helpers/previewMermaid.ts'),
    'utf8'
  );
  assert.equal((indexSource.match(/createMermaidDiagramRenderPool\(/g) ?? []).length, 1);
  assert.equal((indexSource.match(/createMermaidDiagramPresentationFactory\(/g) ?? []).length, 1);
  assert.equal(editorSource.includes('createMermaidDiagramRenderPool'), false);
  assert.equal(editorSource.includes('createMermaidDiagramPresentationFactory'), false);
  assert.equal(editorSource.includes('mermaidDiagramPresentationFactoryFacet'), true);
  assert.equal(widgetSource.includes('editor/mermaidDiagramRenderPool'), false);
  assert.equal(previewSource.includes('editor/mermaidDiagramRenderPool'), false);
  assert.ok(
    indexSource.indexOf('mermaidDiagramPresentationFactory.dispose()')
      < indexSource.indexOf('mermaidDiagramRenderPool.dispose()'),
    'Widget handles must close before the shared Pool'
  );
  for (const legacyOwner of [
    'mermaidInitialized',
    'mermaidCache',
    'mermaidOperationRunning',
    'mermaidHighPriorityOperations',
    'mermaidNormalPriorityOperations',
    'mermaidRenderInFlight',
    'mermaidEstimatedHeightCache',
    'mermaidPreviewHeightCache',
    'mermaidThemeRefreshListeners',
    'runExclusiveMermaidOperation',
    'renderMermaidDiagram('
  ]) {
    assert.equal(widgetSource.includes(legacyOwner), false, `${legacyOwner} must not return`);
  }
  assert.equal(previewSource.includes('runExclusiveMermaidOperation'), false);

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
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const calls: Array<{ source: string; identity: string }> = [];
      let active = 0;
      let maxActive = 0;
      let themeInitializations = 0;
      let activeIdentity = '';
      (window as any).mermaid = {
        initialize(config: unknown) {
          themeInitializations += 1;
          activeIdentity = JSON.stringify(config);
        },
        async render(_id: string, source: string) {
          calls.push({ source, identity: activeIdentity });
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, source.includes('SLOW_OLD') ? 90 : 10));
            if (source.includes('INVALID')) throw new Error('parse error');
            const marker = source.includes('SLOW_OLD')
              ? 'old'
              : source.includes('FAST_NEW')
                ? 'new'
                : source.includes('RECOVERED')
                  ? 'recovered'
                  : 'shared';
            return { svg: `<svg data-marker="${marker}" width="160" height="80"></svg>` };
          } finally {
            active -= 1;
          }
        }
      };

      const harness = (window as any).MermaidEditingHarness;
      const initialText = '```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph TD\nA-->B\n```';
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: initialText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      const settle = async (milliseconds = 80) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let index = 0; index < 6; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const presentText = (text: string) => {
        editor.setText(`${text}\n\nafter`);
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
      };

      await settle();
      editor.setText(initialText);
      await settle(20);
      const shared = {
        renderCalls: calls.length,
        calls: [...calls],
        diagrams: document.querySelectorAll('.meo-mermaid-svg-wrapper').length,
        maxActive
      };

      const beforeRawIsolationCalls = calls.length;
      editor.setText([
        '```mermaid', '$$', 'a+b', '$$', '```', '',
        '```mermaid', '$$', ' a+b ', '$$', '```'
      ].join('\n'));
      await settle();
      const rawIsolationCalls = calls.slice(beforeRawIsolationCalls);
      const rawIsolation = {
        renderCalls: rawIsolationCalls.length,
        normalizedSources: rawIsolationCalls.map((call) => call.source),
        identities: rawIsolationCalls.map((call) => call.identity)
      };

      presentText('```mermaid\nINVALID\n```');
      await settle();
      const invalid = {
        errors: document.querySelectorAll('.meo-mermaid-error-badge').length,
        fallback: document.querySelector('.meo-mermaid-fallback code')?.textContent ?? ''
      };

      presentText('```mermaid\nRECOVERED\n```');
      await settle(140);
      const recovered = {
        marker: document.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-marker') ?? null,
        html: document.querySelector('.meo-mermaid-block')?.innerHTML ?? '',
        calls: [...calls]
      };

      const beforeCachedErrorCalls = calls.length;
      presentText('```mermaid\nINVALID\n```');
      await settle();
      const cachedError = {
        errors: document.querySelectorAll('.meo-mermaid-error-badge').length,
        reusedWithoutRender: calls.length === beforeCachedErrorCalls
      };

      presentText('```mermaid\nSLOW_OLD\n```');
      await settle(20);
      presentText('```mermaid\nFAST_NEW\n```');
      await settle(180);
      const rapid = {
        marker: document.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-marker'),
        oldVisible: Boolean(document.querySelector('svg[data-marker="old"]'))
      };

      const beforeThemeCalls = calls.length;
      document.documentElement.style.setProperty('--meo-background', '#111111');
      document.documentElement.style.setProperty('--meo-foreground', '#eeeeee');
      document.documentElement.style.setProperty('--meo-code-background', '#111111');
      document.documentElement.style.setProperty('--meo-surface-background', '#222222');
      document.documentElement.style.setProperty('--meo-color-base05', '#66aaff');
      harness.refreshMermaidTheme();
      editor.refreshDecorations();
      await settle();
      const theme = {
        rerendered: calls.length > beforeThemeCalls,
        initializations: themeInitializations
      };

      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: 4 } });
      editor.view.scrollDOM.scrollTop = 12;
      const beforeMode = {
        selection: editor.view.state.selection.main.head,
        scrollTop: editor.view.scrollDOM.scrollTop
      };
      editor.setMode('source');
      await settle(20);
      const sourceDiagramCount = document.querySelectorAll('.meo-mermaid-block').length;
      editor.setMode('live');
      await settle();
      const afterMode = {
        selection: editor.view.state.selection.main.head,
        scrollTop: editor.view.scrollDOM.scrollTop,
        focused: editor.view.hasFocus,
        marker: document.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-marker')
      };

      editor.destroy();
      await settle(30);
      return {
        shared,
        rawIsolation,
        invalid,
        recovered,
        cachedError,
        rapid,
        theme,
        beforeMode,
        sourceDiagramCount,
        afterMode,
        editorDomAfterDestroy: document.querySelectorAll('.cm-editor').length,
        mermaidDomAfterDestroy: document.querySelectorAll('.meo-mermaid-block').length
      };
    });

    assert.deepEqual(result.shared, {
      renderCalls: 1,
      calls: [{ source: 'graph TD\nA-->B', identity: result.shared.calls[0]?.identity }],
      diagrams: 2,
      maxActive: 1
    });
    assert.equal(result.rawIsolation.renderCalls, 2);
    assert.equal(result.rawIsolation.normalizedSources[0], result.rawIsolation.normalizedSources[1]);
    assert.equal(result.rawIsolation.identities[0], result.rawIsolation.identities[1]);
    assert.equal(result.invalid.errors, 1);
    assert.equal(result.invalid.fallback, 'INVALID');
    assert.equal(result.recovered.marker, 'recovered', JSON.stringify(result.recovered));
    assert.deepEqual(result.cachedError, { errors: 1, reusedWithoutRender: true });
    assert.deepEqual(result.rapid, { marker: 'new', oldVisible: false });
    assert.equal(result.theme.rerendered, true);
    assert.ok(result.theme.initializations >= 2);
    assert.equal(result.sourceDiagramCount, 0);
    assert.equal(result.afterMode.selection, result.beforeMode.selection);
    assert.equal(result.afterMode.scrollTop, result.beforeMode.scrollTop);
    assert.equal(result.afterMode.focused, true);
    assert.equal(result.afterMode.marker, 'new');
    assert.equal(result.editorDomAfterDestroy, 0);
    assert.equal(result.mermaidDomAfterDestroy, 0);
    console.log('Mermaid diagram presentation production characterization passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
