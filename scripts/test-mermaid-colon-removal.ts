import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { isMermaidOpeningLine } from '../webview/src/helpers/mermaidEditing';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-colon-removal-'));
const backtickFence = String.fromCharCode(96).repeat(3);
const colonDocument = [
  ':::mermaid',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| Alpha | One |',
  '',
  '$$',
  'x + y',
  '$$',
  '',
  ':::'
].join('\n');
const standardMermaidDocument = [
  `${backtickFence}mermaid`,
  'flowchart LR',
  '  Backtick --> Rendered',
  backtickFence,
  '',
  '~~~mermaid',
  'flowchart TD',
  '  Tilde --> Rendered',
  '~~~'
].join('\n');

function assertMermaidOpeningLineSemantics(): void {
  const cases: Array<[string, boolean]> = [
    ['```mermaid', true],
    ['~~~mermaid', true],
    ['  ``` MERMAID   ', true],
    ['\t~~~\tMeRmAiD\t', true],
    ['   ```mermaid extra', true],
    ['    ```mermaid', false],
    ['```markdown', false],
    ['``` mermaidish', false],
    ['```', false],
    [':::mermaid', false],
    [' ::: MERMAID ', false],
    ['::::mermaid', false],
    ['::: mermaid', false],
    [':::\tmermaid', false],
    [':::mermaid extra', false]
  ];
  for (const [line, expected] of cases) {
    assert.equal(
      isMermaidOpeningLine(line),
      expected,
      `Unexpected Mermaid opening classification for ${JSON.stringify(line)}`
    );
  }
}

async function main(): Promise<void> {
  assertMermaidOpeningLineSemantics();
  const colonRendered = renderMarkdownToHtml({
    markdownText: colonDocument,
    markdownFilePath: 'C:/tmp/mermaid-colon.md',
    target: 'html'
  });
  assert.equal(colonRendered.hasMermaid, false, 'Preview/export must not classify :::mermaid as Mermaid');
  assert.doesNotMatch(colonRendered.html, /meo-export-mermaid/, 'Preview/export must not create a Mermaid container');
  assert.match(colonRendered.html, /:::mermaid/, 'Preview/export must preserve the opening colon text');
  assert.match(colonRendered.html, /:::/, 'Preview/export must preserve the closing colon text');
  assert.match(colonRendered.html, /<table/, 'Ordinary colon text must not exclude a following Markdown table');
  assert.match(colonRendered.html, /meo-export-math/, 'Ordinary colon text must not exclude a following display formula');

  const standardRendered = renderMarkdownToHtml({
    markdownText: standardMermaidDocument,
    markdownFilePath: 'C:/tmp/standard-mermaid.md',
    target: 'html'
  });
  assert.equal(standardRendered.hasMermaid, true, 'Standard Mermaid fences must remain renderable');
  assert.equal(
    (standardRendered.html.match(/class="meo-export-mermaid"/g) ?? []).length,
    2,
    'Backtick and tilde Mermaid fences must both use the Preview/export Mermaid path'
  );

  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).__renderedMermaidSources = [];
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          (window as any).__renderedMermaidSources.push(source);
          return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>' };
        }
      };
    });

    const colonLive = await page.evaluate(async (text) => {
      const app = document.getElementById('app')!;
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let index = 0; index < 60; index += 1) {
        if (document.querySelector('.meo-md-html-table') && document.querySelector('.meo-md-math-display')) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const live = {
        text: document.querySelector<HTMLElement>('.cm-content')?.textContent ?? '',
        mermaidBlocks: document.querySelectorAll('.meo-mermaid-block, .meo-mermaid-editing-block').length,
        mermaidToolbars: document.querySelectorAll('.meo-mermaid-toolbar').length,
        tables: document.querySelectorAll('.meo-md-html-table').length,
        math: document.querySelectorAll('.meo-md-math-display').length,
        colonDecorations: document.querySelectorAll('.meo-md-colon-fence-marker, .meo-md-colon-fence-code').length
      };
      editor.setMode('source');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const source = {
        text: document.querySelector<HTMLElement>('.cm-content')?.textContent ?? '',
        colonDecorations: document.querySelectorAll('.meo-md-colon-fence-marker, .meo-md-colon-fence-code').length
      };
      editor.destroy();
      return { live, source };
    }, colonDocument);
    assert.equal(colonLive.live.mermaidBlocks, 0, 'Live must not create a Mermaid block for :::mermaid');
    assert.equal(colonLive.live.mermaidToolbars, 0, 'Live must not create Mermaid controls for :::mermaid');
    assert.equal(colonLive.live.tables > 0, true, 'Colon text must not exclude a Markdown table from Live rendering');
    assert.equal(colonLive.live.math > 0, true, 'Colon text must not exclude display math from Live rendering');
    assert.equal(colonLive.live.text.includes(':::mermaid'), true, 'Live must preserve the opening colon text');
    assert.equal(colonLive.live.text.includes(':::'), true, 'Live must preserve the closing colon text');
    assert.equal(colonLive.live.colonDecorations, 0, 'Live must not apply colon-fence decorations');
    assert.equal(colonLive.source.text.includes(':::mermaid'), true, 'Source must preserve the opening colon text');
    assert.equal(colonLive.source.text.includes('| Alpha | One |'), true, 'Source must preserve content after colon text');
    assert.equal(colonLive.source.text.includes('x + y'), true, 'Source must preserve formula source after colon text');
    assert.equal(colonLive.source.colonDecorations, 0, 'Source must not apply colon-fence decorations');

    const standardLive = await page.evaluate(async (text) => {
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__renderedMermaidSources = [];
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let index = 0; index < 60; index += 1) {
        if (
          document.querySelectorAll('.meo-mermaid-block svg').length === 2 &&
          (window as any).__renderedMermaidSources.length === 2
        ) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const live = {
        blocks: document.querySelectorAll('.meo-mermaid-block').length,
        toolbars: document.querySelectorAll('.meo-mermaid-toolbar').length,
        sources: [...(window as any).__renderedMermaidSources] as string[]
      };
      editor.setMode('source');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const sourceText = document.querySelector<HTMLElement>('.cm-content')?.textContent ?? '';
      editor.destroy();
      return { live, sourceText };
    }, standardMermaidDocument);
    assert.equal(standardLive.live.blocks, 2, 'Live must render backtick and tilde Mermaid fences');
    assert.equal(standardLive.live.toolbars, 2, 'Standard Mermaid fences must retain Live controls');
    assert.deepEqual(
      standardLive.live.sources.sort(),
      ['flowchart LR\n  Backtick --> Rendered', 'flowchart TD\n  Tilde --> Rendered'].sort(),
      'Standard Mermaid fences must retain their source text through the production render path'
    );
    assert.equal(standardLive.sourceText.includes('Backtick --> Rendered'), true, 'Source must expose backtick-fence source');
    assert.equal(standardLive.sourceText.includes('Tilde --> Rendered'), true, 'Source must expose tilde-fence source');
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('Mermaid colon removal checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
