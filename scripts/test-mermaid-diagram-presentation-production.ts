import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-presentation-production-'));

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
      let yielded = false;
      let firstRenderYielded = false;
      setTimeout(() => { yielded = true; }, 0);
      (window as any).mermaid = {
        initialize(config: unknown) {
          themeInitializations += 1;
          activeIdentity = JSON.stringify(config);
        },
        async render(_id: string, source: string) {
          if (calls.length === 0) firstRenderYielded = yielded;
          calls.push({ source, identity: activeIdentity });
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise((resolve) => setTimeout(
              resolve,
              source.includes('SLOW_OLD') || source.includes('SLOW_THEME') ? 90 : 10
            ));
            if (source.includes('INVALID')) throw new Error('parse error');
            const marker = source.includes('SLOW_OLD')
              ? 'old'
              : source.includes('SLOW_THEME')
                ? 'theme'
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
        retriedRender: calls.length > beforeCachedErrorCalls
      };

      presentText('```mermaid\nSLOW_OLD\n```');
      await settle(20);
      presentText('```mermaid\nFAST_NEW\n```');
      await settle(180);
      const rapid = {
        marker: document.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-marker'),
        oldVisible: Boolean(document.querySelector('svg[data-marker="old"]'))
      };

      presentText('```mermaid\nSLOW_THEME\n```');
      await settle(20);
      const beforePendingThemeCalls = calls.length;
      document.documentElement.style.setProperty('--meo-background', '#151515');
      document.documentElement.style.setProperty('--meo-foreground', '#f0f0f0');
      document.documentElement.style.setProperty('--meo-code-background', '#151515');
      document.documentElement.style.setProperty('--meo-surface-background', '#252525');
      document.documentElement.style.setProperty('--meo-color-base05', '#88bbff');
      harness.refreshMermaidTheme();
      editor.refreshDecorations();
      await settle(180);
      const pendingTheme = {
        marker: document.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-marker') ?? null,
        errors: document.querySelectorAll('.meo-mermaid-error-badge').length,
        replacementErrorVisible: document.body.textContent?.includes('theme generation was replaced') ?? false,
        rerendered: calls.length > beforePendingThemeCalls
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
        firstRenderYielded,
        shared,
        rawIsolation,
        invalid,
        recovered,
        cachedError,
        rapid,
        pendingTheme,
        theme,
        beforeMode,
        sourceDiagramCount,
        afterMode,
        editorDomAfterDestroy: document.querySelectorAll('.cm-editor').length,
        mermaidDomAfterDestroy: document.querySelectorAll('.meo-mermaid-block').length
      };
    });

    assert.equal(result.firstRenderYielded, true, 'Initial diagram computation must yield beyond editor initialization');
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
    assert.deepEqual(result.cachedError, { errors: 1, retriedRender: true });
    assert.deepEqual(result.rapid, { marker: 'new', oldVisible: false });
    assert.deepEqual(result.pendingTheme, {
      marker: 'theme',
      errors: 0,
      replacementErrorVisible: false,
      rerendered: true
    });
    assert.equal(result.theme.rerendered, true);
    assert.ok(result.theme.initializations >= 2);
    assert.equal(result.sourceDiagramCount, 0);
    assert.equal(result.afterMode.selection, result.beforeMode.selection);
    assert.equal(result.afterMode.scrollTop, result.beforeMode.scrollTop);
    assert.equal(result.afterMode.focused, true);
    assert.equal(result.afterMode.marker, 'theme');
    assert.equal(result.editorDomAfterDestroy, 0);
    assert.equal(result.mermaidDomAfterDestroy, 0);

    await page.setViewport({ width: 1000, height: 380, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      const scope = window as any, render = scope.mermaid.render.bind(scope.mermaid);
      scope.__visibilityCalls = [];
      scope.__activeDiagramObservers = new Set();
      const NativeIntersectionObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeIntersectionObserver {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          super(callback, options);
          if (options?.root) scope.__notifyDiagramVisibility = (target: Element, isIntersecting: boolean) =>
            callback([{ target, isIntersecting } as IntersectionObserverEntry], this);
        }
        observe(target: Element) {
          if (target.matches('.meo-mermaid-block')) scope.__activeDiagramObservers.add(this);
          super.observe(target);
        }
        disconnect() { scope.__activeDiagramObservers.delete(this); super.disconnect(); }
      };
      scope.mermaid.render = (id: string, source: string, ...args: unknown[]) => {
        if (source.includes('OFFSCREEN')) scope.__visibilityCalls.push(source);
        return render(id, source, ...args);
      };
      scope.__visibilityText = Array.from({ length: 28 }, (_, index) => `Spacer ${index}.`).join('\n')
        + '\n\n```mermaid\ngraph TD\nOFFSCREEN_OLD-->B\n```\n\n'
        + 'Tail ordinary paragraph with enough source to use the bounded editor.\n'.repeat(6_000);
      scope.__visibilityEditor = scope.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'),
        text: scope.__visibilityText, initialMode: 'live', onApplyChanges() {} });
    });
    const settleVisibility = () => page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    await settleVisibility();
    const hidden = await page.evaluate(() => {
      const scope = window as any, bounds = scope.__visibilityEditor.view.scrollDOM.getBoundingClientRect();
      const widget = document.querySelector('.meo-mermaid-block')!;
      return { mounted: !!widget, beyond: widget?.getBoundingClientRect().top - bounds.bottom, height: widget?.getBoundingClientRect().height,
        calls: scope.__visibilityCalls.length };
    });
    assert.ok(hidden.mounted && hidden.beyond > 80, 'the real CodeMirror overscan must mount a diagram outside the physical screen');
    assert.ok(hidden.height > 0, 'a gated diagram must reserve its estimated document height');
    assert.equal(hidden.calls, 0, 'an offscreen overscan diagram must not start Mermaid layout');
    const reveal = () => page.evaluate(() => {
      const editor = (window as any).__visibilityEditor, widget = document.querySelector('.meo-mermaid-block')!;
      editor.view.scrollDOM.scrollTop += widget.getBoundingClientRect().top - editor.view.scrollDOM.getBoundingClientRect().top - 60;
    });
    await reveal();
    await page.waitForFunction(() => (window as any).__visibilityCalls.length === 1 && !!document.querySelector('.meo-mermaid-svg-wrapper'));
    await settleVisibility();
    await page.evaluate(() => { (window as any).__visibleDiagramSvg = document.querySelector('.meo-mermaid-svg-wrapper'); });
    await page.evaluate(() => {
      const scope = window as any, widget = document.querySelector('.meo-mermaid-block')!;
      scope.__notifyDiagramVisibility(widget, false); scope.__notifyDiagramVisibility(widget, true);
    });
    await settleVisibility();
    assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-svg-wrapper') === (window as any).__visibleDiagramSvg), true,
      'visibility notifications on retained DOM must preserve an unchanged SVG and camera');
    await page.evaluate(() => { (window as any).__visibilityEditor.view.scrollDOM.scrollTop = 0; });
    await settleVisibility();
    await page.evaluate(() => {
      const scope = window as any;
      scope.__visibilityEditor.setText(scope.__visibilityText.replace('OFFSCREEN_OLD', 'OFFSCREEN_NEW'));
    });
    await settleVisibility();
    assert.equal(await page.evaluate(() => (window as any).__visibilityCalls.length), 1,
      'offscreen source replacement must wait for visibility and retain the newest request');
    await reveal();
    await page.waitForFunction(() => (window as any).__visibilityCalls.some((source: string) => source.includes('OFFSCREEN_NEW')));
    await page.waitForSelector('.meo-mermaid-svg-wrapper');
    const cachedHidden = await page.evaluate(async () => {
      const scope = window as any, editor = scope.__visibilityEditor, before = editor.getText();
      await editor.setMode('source'); editor.view.scrollDOM.scrollTop = 0;
      await editor.setMode('live');
      for (let frame = 0; frame < 8; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const widget = document.querySelector('.meo-mermaid-block')!;
      return { exact: editor.getText() === before, height: widget.getBoundingClientRect().height,
        svg: !!widget.querySelector('.meo-mermaid-svg-wrapper') };
    });
    assert.deepEqual({ exact: cachedHidden.exact, svg: cachedHidden.svg }, { exact: true, svg: false },
      'mode reentry must preserve exact source and defer cached offscreen SVG DOM too');
    assert.ok(cachedHidden.height > 0);
    await reveal(); await page.waitForSelector('.meo-mermaid-svg-wrapper');
    await page.evaluate(() => {
      const scope = window as any;
      scope.__visibilityEditor.destroy(); scope.MermaidEditingHarness.refreshMermaidTheme();
    });
    await settleVisibility();
    assert.equal(await page.evaluate(() => (window as any).__visibilityCalls.length), 2,
      'disposing a visibility-gated diagram must retire its observer and queued presentation');
    assert.equal(await page.evaluate(() => (window as any).__activeDiagramObservers.size), 0,
      'mode changes and disposal must release observers owned by retained diagram DOM');
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
