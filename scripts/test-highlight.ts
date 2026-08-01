import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { defaultThemeSettings } from '../src/shared/themeDefaults';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-highlight-'));
const richHighlight = '==高亮 **粗体** *斜体* ~~删除~~ [链接](https://example.com) `代码`==';

const rendered = exportRuntime.renderExportHtmlDocument({
  markdownText: [richHighlight, '', '**粗体里的 ==高亮==**', '', '====', '', '\\==不高亮=='].join('\n'),
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html',
  htmlImageMode: 'embedded',
  theme: defaultThemeSettings,
  appearance: 'dark',
  styleEnvironment: {
    editorBackgroundColor: '#20252b',
    editorForegroundColor: '#d8dee9',
    codeBlockBackgroundColor: '#171b20',
    sideBarBackgroundColor: '#252b32',
    panelBorderColor: '#474b50'
  },
  mermaidRuntimeSrc: 'mermaid.min.js',
  baseHref: 'file:///C:/tmp/',
  title: 'Highlight test'
});

if (!/<mark>高亮 <strong>粗体<\/strong> <em>斜体<\/em> <s>删除<\/s>/.test(rendered.htmlDocument)) {
  throw new Error('Export did not preserve rich inline formatting inside highlight');
}
if (!/<strong>粗体里的 <mark>高亮<\/mark><\/strong>/.test(rendered.htmlDocument)) {
  throw new Error('Export did not preserve highlight nested inside bold text');
}
if (!/<p[^>]*>====<\/p>/.test(rendered.htmlDocument) || rendered.htmlDocument.includes('<mark></mark>')) {
  throw new Error('Empty highlight markers must remain plain text');
}

const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts', 'test-highlight-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addStyleTag({
    content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
  });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

  const source = [
    '普通行',
    richHighlight,
    '====',
    '\\==不高亮==',
    '# ==高亮标题==',
    '',
    '| 列 |',
    '| --- |',
    '| ==表格 **粗体**== |',
    '',
    '格式化目标'
  ].join('\n');

  const live = await page.evaluate(async (text) => {
    const harness = (window as any).HighlightHarness;
    const editor = harness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
    (window as any).__highlightEditor = editor;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const menu = harness.createSelectionMenu().menu;
    menu.querySelector<HTMLElement>('.selection-inline-suggestions')!.hidden = true;
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const buttons = Array.from(menu.querySelectorAll<HTMLElement>('.selection-inline-button'));
    const firstButton = buttons[0];
    const lastButton = buttons.at(-1);
    const firstButtonRect = firstButton?.getBoundingClientRect();
    const lastButtonRect = lastButton?.getBoundingClientRect();
    return {
      highlightTexts: Array.from(document.querySelectorAll('.meo-md-highlight')).map((node) => node.textContent),
      emptyLineHighlighted: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent === '====' && line.querySelector('.meo-md-highlight')),
      tableHighlight: Array.from(document.querySelectorAll('.meo-md-highlight'))
        .find((node) => node.textContent?.includes('表格'))?.textContent ?? null,
      toolbarButton: Boolean(menu.querySelector('[data-action="highlight"]')),
      toolbarGeometry: {
        outerRadius: getComputedStyle(menu).borderRadius,
        innerRadius: firstButton ? getComputedStyle(firstButton).borderRadius : null,
        topInset: firstButtonRect ? firstButtonRect.top - menuRect.top : null,
        bottomInset: firstButtonRect ? menuRect.bottom - firstButtonRect.bottom : null,
        leftInset: firstButtonRect ? firstButtonRect.left - menuRect.left : null,
        rightInset: lastButtonRect ? menuRect.right - lastButtonRect.right : null
      },
      headingHighlight: editor.getHeadings()[0]?.inlineSegments?.some((segment: any) => segment.highlight) ?? false
    };
  }, source);

  if (!live.highlightTexts.some((text) => text?.includes('高亮')) || live.emptyLineHighlighted) {
    throw new Error(`Live highlight parsing failed: ${JSON.stringify(live)}`);
  }
  if (!live.tableHighlight?.includes('表格') || !live.toolbarButton || !live.headingHighlight) {
    throw new Error(`Highlight integration is incomplete: ${JSON.stringify(live)}`);
  }
  const toolbarInsets = [
    live.toolbarGeometry.topInset,
    live.toolbarGeometry.bottomInset,
    live.toolbarGeometry.leftInset,
    live.toolbarGeometry.rightInset
  ];
  if (
    live.toolbarGeometry.outerRadius !== '8px' ||
    live.toolbarGeometry.innerRadius !== '5px' ||
    toolbarInsets.some((inset) => inset === null || Math.abs(inset - 3) >= 0.01)
  ) {
    throw new Error(`Selection toolbar geometry is not concentric: ${JSON.stringify(live.toolbarGeometry)}`);
  }

  const sourceModeHighlightCount = await page.evaluate(async () => {
    const editor = (window as any).__highlightEditor;
    editor.setMode('source');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.querySelectorAll('.cm-editor.meo-mode-source .meo-md-highlight').length;
  });
  if (sourceModeHighlightCount < 3) throw new Error('Source mode did not decorate highlighted text');

  const formattedText = await page.evaluate(() => {
    const editor = (window as any).__highlightEditor;
    const text = editor.getText();
    const from = text.indexOf('格式化目标');
    editor.view.dispatch({ selection: { anchor: from, head: from + '格式化目标'.length } });
    editor.insertFormat('highlight');
    return editor.getText();
  });
  if (!formattedText.includes('==格式化目标==')) throw new Error('Highlight toolbar action did not wrap the selection');

  console.log('Highlight syntax test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
