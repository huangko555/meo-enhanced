import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-rendered-mode-shell-'));

const rendererProbeModule = String.raw`
type Probe =
  | { kind: 'normal' }
  | { kind: 'forbid' }
  | { kind: 'require-visible-source' }
  | { kind: 'error' };

let probe: Probe = { kind: 'normal' };
let violation: string | null = null;

export function setMathRendererProbe(next: Probe): void {
  probe = next;
  violation = null;
}

export function getMathRendererProbeViolation(): string | null {
  return violation;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderMathToHtml(content: string): string | null {
  if (probe.kind === 'forbid') {
    violation = 'Source mode called the LaTeX renderer';
  }
  if (probe.kind === 'require-visible-source') {
    const source = document.querySelector<HTMLElement>(
      '.meo-latex-math-editing-block.is-split .meo-latex-math-source-pane'
    );
    if (!source?.textContent?.includes(content)) {
      violation = 'Split mode rendered before the edited source became visible';
    }
  }
  if (probe.kind === 'error') {
    return null;
  }
  return '<span class="katex" data-rendered-math>' + escapeHtml(content) + '</span>';
}
`;

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-rendered-block-mode-shell-production-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [{
      name: 'controlled-math-renderer',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]src[\\/]shared[\\/]mathRenderer\.ts$/ }, () => ({
          contents: rendererProbeModule,
          loader: 'ts'
        }));
      }
    }]
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-color-base05:#0969da;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:500;--meo-font-source-size:14px;--meo-semantic-mutedForeground:#57606a;--meo-semantic-codeCopyForeground:#0969da;--meo-semantic-codeCopyBackground:transparent;--meo-semantic-codeCopyHoverForeground:#0969da;--meo-semantic-codeCopyHoverBackground:#eaeef2;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const harness = (window as any).RenderedBlockModeShellProductionHarness;
      (window as any).__renderedModeEditor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: '$$\nx = 1\n$$',
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForSelector('.meo-latex-math-mode-btn');

    await page.click('.meo-latex-math-mode-btn');
    await page.waitForSelector('.meo-latex-math-editing-block.is-split');
    await page.evaluate(() => {
      (window as any).RenderedBlockModeShellProductionHarness.setMathRendererProbe({ kind: 'forbid' });
    });
    await page.click('.meo-latex-math-mode-btn');
    await page.waitForSelector('.meo-latex-math-editing-block.is-source');
    assert.equal(await page.evaluate(() => (
      (window as any).RenderedBlockModeShellProductionHarness.getMathRendererProbeViolation()
    )), null);
    await page.click('.meo-latex-math-editing-block.is-source .cm-content');
    await page.keyboard.press('End');
    await page.keyboard.type(' + source_guard');
    await page.waitForFunction(() => (
      document.querySelector('.meo-latex-math-editing-block.is-source .meo-latex-math-source-pane')
        ?.textContent?.includes('source_guard') === true
    ));
    await page.evaluate(() => {
      (window as any).__renderedModeEditor.setText('$$\nx = 1 + source_external\n$$');
    });
    assert.equal(await page.evaluate(() => (
      (window as any).RenderedBlockModeShellProductionHarness.getMathRendererProbeViolation()
    )), null);
    assert.deepEqual(pageErrors, [], 'Source mode must not call the LaTeX renderer');

    await page.evaluate(() => {
      (window as any).RenderedBlockModeShellProductionHarness.setMathRendererProbe({ kind: 'normal' });
    });
    await page.click('.meo-latex-math-mode-btn');
    await page.waitForSelector('.meo-md-math-display');
    await page.click('.meo-latex-math-mode-btn');
    await page.waitForSelector('.meo-latex-math-editing-block.is-split');
    await page.evaluate(() => {
      (window as any).RenderedBlockModeShellProductionHarness.setMathRendererProbe({
        kind: 'require-visible-source'
      });
    });
    await page.click('.meo-latex-math-editing-block.is-split .cm-content');
    await page.keyboard.press('End');
    await page.keyboard.type(' + split_visible_first');
    assert.equal(await page.evaluate(() => (
      document.querySelector('.meo-latex-math-editing-block.is-split [data-rendered-math]')
        ?.textContent?.includes('split_visible_first') === true
    )), true, 'Split mode must expose the synchronous renderer result before the edit completes');
    assert.equal(await page.evaluate(() => (
      (window as any).RenderedBlockModeShellProductionHarness.getMathRendererProbeViolation()
    )), null);
    const beforeErrorEdit = await page.evaluate(() => {
      const outerScroller = document.querySelector<HTMLElement>('#app > .cm-editor > .cm-scroller')!;
      return { scrollTop: outerScroller.scrollTop };
    });
    await page.evaluate(() => {
      (window as any).RenderedBlockModeShellProductionHarness.setMathRendererProbe({ kind: 'error' });
    });
    await page.keyboard.type(' + invalid_sync');
    const afterErrorEdit = await page.evaluate(() => {
      const source = document.querySelector<HTMLElement>('.meo-latex-math-editing-block.is-split .meo-latex-math-source-pane')!;
      const error = document.querySelector<HTMLElement>('.meo-latex-math-editing-block.is-split .meo-latex-math-preview-error');
      const selection = window.getSelection();
      const outerScroller = document.querySelector<HTMLElement>('#app > .cm-editor > .cm-scroller')!;
      return {
        errorText: error?.textContent ?? null,
        sourceFocused: source.contains(document.activeElement),
        caretInSource: Boolean(selection?.isCollapsed && selection.anchorNode && source.contains(selection.anchorNode)),
        scrollTop: outerScroller.scrollTop
      };
    });
    assert.equal(afterErrorEdit.errorText?.includes('invalid_sync'), true,
      'Split mode must expose a synchronous renderer error before the edit completes');
    assert.equal(afterErrorEdit.sourceFocused, true, 'Synchronous renderer errors must preserve source focus');
    assert.equal(afterErrorEdit.caretInSource, true, 'Synchronous renderer errors must preserve the public DOM caret');
    assert.ok(Math.abs(afterErrorEdit.scrollTop - beforeErrorEdit.scrollTop) <= 1,
      'Synchronous renderer errors must not move the outer viewport');
    assert.deepEqual(pageErrors, [], 'Split mode must expose source text before rendering');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('Rendered block mode shell production tests passed');
}

await main();
