import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-highlight-'));
const richHighlight = '==高亮 **粗体** *斜体* ~~删除~~ [链接](https://example.com) `代码`==';

const rendered = exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'highlight',
    text: [richHighlight, '', '**粗体里的 ==高亮==**', '', '====', '', '\\==不高亮=='].join('\n'),
    appearance: 'dark',
    uiLanguage: 'en',
    environment: {
      previewFontFamily: '',
      editorBackgroundColor: '#20252b',
      editorForegroundColor: '#d8dee9',
      codeBlockBackgroundColor: '#171b20',
      sideBarBackgroundColor: '#252b32',
      panelBorderColor: '#474b50'
    }
  },
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html',
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
    content: ':root { --vscode-editor-foreground:#e6edf3; --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-token-tagName-color:#112233; --meo-token-string-color:#223344; --meo-token-atom-color:#334455; --meo-token-number-color:#445566; --meo-token-punctuation-color:#556677; --meo-token-listMarker-color:#778899; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
  });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

  const source = [
    '---',
    'title: Alpha',
    'draft: true',
    'version: 2',
    '---',
    '',
    '普通行',
    '1. 原生列表颜色',
    richHighlight,
    '====',
    '\\==不高亮==',
    '# ==高亮标题==',
    '',
    '| 列 |',
    '| --- |',
    '| ==表格 **粗体**== |',
    '',
    '上下标 H~2~O x^2^ CO~2~',
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
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const buttons = Array.from(menu.querySelectorAll<HTMLElement>('.selection-inline-button'));
    const firstButton = buttons[0];
    const lastButton = buttons.at(-1);
    const firstButtonRect = firstButton?.getBoundingClientRect();
    const lastButtonRect = lastButton?.getBoundingClientRect();
    const renderedHighlight = document.querySelector<HTMLElement>('.meo-md-highlight');
    const boldIcon = menu.querySelector<SVGElement>('[data-action="bold"] svg');
    const highlightIconPaths = Array.from(
      menu.querySelectorAll<SVGPathElement>('[data-action="highlight"] svg path')
    );
    return {
      highlightTexts: Array.from(document.querySelectorAll('.meo-md-highlight')).map((node) => node.textContent),
      emptyLineHighlighted: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent === '====' && line.querySelector('.meo-md-highlight')),
      tableHighlight: Array.from(document.querySelectorAll('.meo-md-highlight'))
        .find((node) => node.textContent?.includes('表格'))?.textContent ?? null,
      toolbarButton: Boolean(menu.querySelector('[data-action="highlight"]')),
      underlineToolbarButton: Boolean(menu.querySelector('[data-action="underline"]')),
      toolbarActions: buttons.map((button) => button.dataset.action),
      lastToolbarAction: lastButton?.dataset.action ?? null,
      toolbarGeometry: {
        outerRadius: getComputedStyle(menu).borderRadius,
        innerRadius: firstButton ? getComputedStyle(firstButton).borderRadius : null,
        topInset: firstButtonRect ? firstButtonRect.top - menuRect.top : null,
        bottomInset: firstButtonRect ? menuRect.bottom - firstButtonRect.bottom : null,
        leftInset: firstButtonRect ? firstButtonRect.left - menuRect.left : null,
        rightInset: lastButtonRect ? menuRect.right - lastButtonRect.right : null
      },
      highlightVisuals: {
        textBackground: renderedHighlight ? getComputedStyle(renderedHighlight).backgroundColor : null,
        iconFills: highlightIconPaths.map((path) => getComputedStyle(path).fill),
        boldStrokeWidth: boldIcon?.getAttribute('stroke-width') ?? null
      },
      headingHighlight: editor.getHeadings()[0]?.inlineSegments?.some((segment: any) => segment.highlight) ?? false,
      subscripts: Array.from(document.querySelectorAll('.meo-md-subscript')).map((node) => node.textContent),
      superscripts: Array.from(document.querySelectorAll('.meo-md-superscript')).map((node) => node.textContent)
    };
  }, source);

  if (!live.highlightTexts.some((text) => text?.includes('高亮')) || live.emptyLineHighlighted) {
    throw new Error(`Live highlight parsing failed: ${JSON.stringify(live)}`);
  }
  if (
    !live.tableHighlight?.includes('表格') ||
    !live.toolbarButton ||
    !live.underlineToolbarButton ||
    JSON.stringify(live.toolbarActions) !== JSON.stringify([
      'bold',
      'italic',
      'lineover',
      'highlight',
      'inlineCode',
      'link',
      'wikiLink',
      'kbd',
      'underline'
    ]) ||
    live.lastToolbarAction !== 'underline' ||
    !live.headingHighlight
  ) {
    throw new Error(`Highlight integration is incomplete: ${JSON.stringify(live)}`);
  }
  if (
    JSON.stringify(live.subscripts) !== JSON.stringify(['2', '2'])
    || JSON.stringify(live.superscripts) !== JSON.stringify(['2'])
  ) {
    throw new Error(`Live subscript/superscript rendering is incomplete: ${JSON.stringify(live)}`);
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
  if (
    live.highlightVisuals.boldStrokeWidth !== '2.75'
    || live.highlightVisuals.iconFills.length !== 2
    || live.highlightVisuals.iconFills.some((fill) => fill !== live.highlightVisuals.textBackground)
  ) {
    throw new Error(`Selection toolbar emphasis visuals are inconsistent: ${JSON.stringify(live.highlightVisuals)}`);
  }

  const sourceModeVisuals = await page.evaluate(async () => {
    const editor = (window as any).__highlightEditor;
    editor.setMode('source');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const color = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? getComputedStyle(element).color : null;
    };
    const nestedProbe = document.createElement('div');
    nestedProbe.className = 'cm-editor meo-mode-source';
    nestedProbe.innerHTML = '<span class="meo-md-list-prefix"><span class="cm-list-token" style="color: rgb(1, 2, 3)">1.</span></span>';
    document.body.append(nestedProbe);
    const nestedListMarker = color('.meo-mode-source .meo-md-list-prefix .cm-list-token');
    nestedProbe.remove();
    return {
      highlightCount: document.querySelectorAll('.cm-editor.meo-mode-source .meo-md-highlight').length,
      key: color('.meo-mode-source .meo-md-frontmatter-key'),
      punctuation: color('.meo-mode-source .meo-md-frontmatter-punctuation'),
      string: color('.meo-mode-source .meo-md-frontmatter-value.is-string'),
      literal: color('.meo-mode-source .meo-md-frontmatter-value.is-literal'),
      number: color('.meo-mode-source .meo-md-frontmatter-value.is-number'),
      listMarker: color('.meo-mode-source .meo-md-list-prefix'),
      nestedListMarker
    };
  });
  if (
    sourceModeVisuals.highlightCount < 3
    || sourceModeVisuals.key !== 'rgb(17, 34, 51)'
    || sourceModeVisuals.punctuation !== 'rgb(85, 102, 119)'
    || sourceModeVisuals.string !== 'rgb(34, 51, 68)'
    || sourceModeVisuals.literal !== 'rgb(51, 68, 85)'
    || sourceModeVisuals.number !== 'rgb(68, 85, 102)'
    || sourceModeVisuals.listMarker !== 'rgb(119, 136, 153)'
    || sourceModeVisuals.nestedListMarker !== 'rgb(119, 136, 153)'
  ) {
    throw new Error(`Source mode did not use VS Code token variables: ${JSON.stringify(sourceModeVisuals)}`);
  }

  const formattedText = await page.evaluate(() => {
    const editor = (window as any).__highlightEditor;
    const text = editor.getText();
    const from = text.indexOf('格式化目标');
    editor.view.dispatch({ selection: { anchor: from, head: from + '格式化目标'.length } });
    editor.insertFormat('highlight');
    return editor.getText();
  });
  if (!formattedText.includes('==格式化目标==')) throw new Error('Highlight toolbar action did not wrap the selection');

  const underlinedText = await page.evaluate(() => {
    const editor = (window as any).__highlightEditor;
    const text = editor.getText();
    const from = text.indexOf('格式化目标');
    editor.view.dispatch({ selection: { anchor: from, head: from + '格式化目标'.length } });
    editor.insertFormat('underline');
    return editor.getText();
  });
  if (!underlinedText.includes('==<u>格式化目标</u>==')) {
    throw new Error(`Underline toolbar action did not wrap the selection: ${underlinedText}`);
  }

  const nativePaletteVisuals = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    (window as any).__highlightEditor.destroy();
    document.getElementById('app')!.replaceChildren();
    harness.applyBuiltInVisualBaseline('dark');
    const paletteAdapter = harness.createCodePaletteWebviewAdapter({ setShikiTheme: harness.setShikiTheme });
    const darkPalette = paletteAdapter.resolve({
      name: 'GitHub Dark Dimmed fixture',
      type: 'dark',
      colors: { 'editor.foreground': '#adbac7' },
      tokenColors: [
        { scope: 'punctuation.definition.list.begin.markdown', settings: { foreground: '#f69d50' } },
        { scope: 'markup.heading', settings: { foreground: '#79c0ff' } },
        { scope: 'markup.bold', settings: { foreground: '#adbac7', fontStyle: 'bold' } },
        { scope: 'markup.italic', settings: { foreground: '#adbac7', fontStyle: 'italic' } },
        { scope: 'markup.inline.raw', settings: { foreground: '#6cb6ff' } },
        { scope: 'constant.numeric', settings: { foreground: '#39d353' } }
      ]
    }, 'dark');
    paletteAdapter.apply(darkPalette);
    harness.activateShikiCodeHighlighting('preview');
    harness.setShikiTheme(darkPalette.sourceTheme, 'preview');
    const editor = harness.createEditor({
      parent: document.getElementById('app')!,
      text: [
        '# 标题内容',
        '',
        '普通正文',
        '',
        '1. 列表项目',
        '',
        '**粗体内容** *斜体内容*',
        '',
        '```',
        'plainFenceToken',
        '```',
        '',
        '```typescript',
        'const nativeValue: number = 42;',
        '```',
        '',
        '```ruby',
        'native_value = 73',
        '```'
      ].join('\n'),
      initialMode: 'source',
      onApplyChanges() {}
    });
    (window as any).__nativePaletteEditor = editor;
    (window as any).__nativePaletteAdapter = paletteAdapter;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const codeTokenReady = async (): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (Array.from(editor.view.dom.querySelectorAll<HTMLElement>('span[style*="color:"]'))
          .some((node) => node.textContent?.includes('42'))) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Source code block did not receive the shared native token palette');
    };
    await codeTokenReady();
    const colorForText = (needle: string): string | null => {
      const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(needle)) {
          return getComputedStyle(node.parentElement ?? editor.view.dom).color;
        }
      }
      return null;
    };
    const colorAtPosition = (position: number): string | null => {
      const target = editor.view.domAtPos(position).node;
      const element = target instanceof HTMLElement ? target : target.parentElement;
      return element ? getComputedStyle(element).color : null;
    };
    return {
      headingMarker: colorAtPosition(0),
      headingText: colorAtPosition(2),
      plain: colorForText('普通正文'),
      list: getComputedStyle(document.querySelector<HTMLElement>('.meo-mode-source .meo-md-list-prefix')!).color,
      bold: colorForText('粗体内容'),
      italic: colorForText('斜体内容'),
      sourcePlainCode: colorForText('plainFenceToken'),
      sourceCodeNumber: colorForText('42'),
      sourceRubyNumber: colorForText('73')
    };
  });
  const expectedNativePaletteVisuals = {
    headingMarker: 'rgb(121, 192, 255)',
    headingText: 'rgb(121, 192, 255)',
    plain: 'rgb(173, 186, 199)',
    list: 'rgb(246, 157, 80)',
    bold: 'rgb(173, 186, 199)',
    italic: 'rgb(173, 186, 199)',
    sourcePlainCode: 'rgb(173, 186, 199)',
    sourceCodeNumber: 'rgb(57, 211, 83)',
    sourceRubyNumber: 'rgb(57, 211, 83)'
  };
  if (JSON.stringify(nativePaletteVisuals) !== JSON.stringify(expectedNativePaletteVisuals)) {
    throw new Error(`Source did not reproduce the native VS Code Markdown palette: ${JSON.stringify(nativePaletteVisuals)}`);
  }

  const unifiedDarkCodePalette = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const editor = (window as any).__nativePaletteEditor;
    const colorForText = (root: ParentNode, needle: string): string | null => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(needle)) {
          return getComputedStyle(node.parentElement ?? editor.view.dom).color;
        }
      }
      return null;
    };
    const waitForColor = async (root: ParentNode, needle: string, expected: string): Promise<string | null> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const color = colorForText(root, needle);
        if (color === expected) return color;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return colorForText(root, needle);
    };
    const waitForPreviewColor = async (
      root: ParentNode,
      needle: string,
      expected: string
    ): Promise<string | null> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        harness.applyPreviewCodeHighlight(document);
        const color = colorForText(root, needle);
        if (color === expected) return color;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return colorForText(root, needle);
    };
    const source = colorForText(editor.view.dom, '42');
    const sourceRuby = await waitForColor(editor.view.dom, '73', 'rgb(57, 211, 83)');
    const sourcePlain = colorForText(editor.view.dom, 'plainFenceToken');
    editor.setMode('live');
    const live = await waitForColor(editor.view.dom, '42', 'rgb(57, 211, 83)');
    const liveRuby = await waitForColor(editor.view.dom, '73', 'rgb(57, 211, 83)');
    const livePlain = colorForText(editor.view.dom, 'plainFenceToken');

    const preview = document.createElement('pre');
    preview.id = 'native-code-palette-preview';
    preview.innerHTML = '<code class="hljs language-typescript"><span class="meo-export-code-line-source">const nativeValue: number = 42;</span></code>';
    document.body.append(preview);
    const previewColor = await waitForPreviewColor(preview, '42', 'rgb(57, 211, 83)');
    const rubyPreview = document.createElement('pre');
    rubyPreview.id = 'native-ruby-code-palette-preview';
    rubyPreview.innerHTML = '<code class="hljs language-ruby"><span class="meo-export-code-line-source">native_value = 73</span></code>';
    document.body.append(rubyPreview);
    const previewRuby = await waitForPreviewColor(rubyPreview, '73', 'rgb(57, 211, 83)');
    const plainPreview = document.createElement('pre');
    plainPreview.id = 'native-plain-code-palette-preview';
    plainPreview.style.color = 'rgb(173, 186, 199)';
    plainPreview.innerHTML = '<code class="hljs"><span class="meo-export-code-line-source">plainFenceToken</span></code>';
    document.body.append(plainPreview);
    harness.applyPreviewCodeHighlight(document);
    const previewPlain = colorForText(plainPreview, 'plainFenceToken');
    return {
      source,
      live,
      preview: previewColor,
      sourceRuby,
      liveRuby,
      previewRuby,
      sourcePlain,
      livePlain,
      previewPlain
    };
  });
  const expectedUnifiedDark = {
    source: 'rgb(57, 211, 83)',
    live: 'rgb(57, 211, 83)',
    preview: 'rgb(57, 211, 83)',
    sourceRuby: 'rgb(57, 211, 83)',
    liveRuby: 'rgb(57, 211, 83)',
    previewRuby: 'rgb(57, 211, 83)',
    sourcePlain: 'rgb(173, 186, 199)',
    livePlain: 'rgb(173, 186, 199)',
    previewPlain: 'rgb(173, 186, 199)'
  };
  if (JSON.stringify(unifiedDarkCodePalette) !== JSON.stringify(expectedUnifiedDark)) {
    throw new Error(`Dark code palette diverged across modes: ${JSON.stringify(unifiedDarkCodePalette)}`);
  }

  const unifiedLightCodePalette = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const editor = (window as any).__nativePaletteEditor;
    const paletteAdapter = (window as any).__nativePaletteAdapter;
    harness.applyBuiltInVisualBaseline('light');
    const lightPalette = paletteAdapter.resolve({
      name: 'Native Light fixture',
      type: 'light',
      colors: { 'editor.foreground': '#24292f', 'editor.background': '#ffffff' },
      tokenColors: [{ scope: 'constant.numeric', settings: { foreground: '#0969da' } }]
    }, 'light');
    paletteAdapter.apply(lightPalette);
    harness.setShikiTheme(lightPalette.sourceTheme, 'preview');
    const colorForText = (root: ParentNode, needle: string): string | null => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(needle)) {
          return getComputedStyle(node.parentElement ?? editor.view.dom).color;
        }
      }
      return null;
    };
    const waitForColor = async (root: ParentNode, needle: string, expected: string): Promise<string | null> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const color = colorForText(root, needle);
        if (color === expected) return color;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return colorForText(root, needle);
    };

    const live = await waitForColor(editor.view.dom, '42', 'rgb(9, 105, 218)');
    const liveRuby = await waitForColor(editor.view.dom, '73', 'rgb(9, 105, 218)');
    const livePlain = colorForText(editor.view.dom, 'plainFenceToken');
    editor.setMode('source');
    const source = await waitForColor(editor.view.dom, '42', 'rgb(9, 105, 218)');
    const sourceRuby = await waitForColor(editor.view.dom, '73', 'rgb(9, 105, 218)');
    const sourcePlain = colorForText(editor.view.dom, 'plainFenceToken');

    const preview = document.getElementById('native-code-palette-preview')!;
    let previewColor: string | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      harness.applyPreviewCodeHighlight(document);
      previewColor = colorForText(preview, '42');
      if (previewColor === 'rgb(9, 105, 218)') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    preview.remove();
    const rubyPreview = document.getElementById('native-ruby-code-palette-preview')!;
    const previewRuby = await waitForColor(rubyPreview, '73', 'rgb(9, 105, 218)');
    rubyPreview.remove();
    const plainPreview = document.getElementById('native-plain-code-palette-preview')!;
    plainPreview.style.color = 'rgb(36, 41, 47)';
    const previewPlain = colorForText(plainPreview, 'plainFenceToken');
    plainPreview.remove();
    return {
      source,
      live,
      preview: previewColor,
      sourceRuby,
      liveRuby,
      previewRuby,
      sourcePlain,
      livePlain,
      previewPlain
    };
  });
  const expectedUnifiedLight = {
    source: 'rgb(9, 105, 218)',
    live: 'rgb(9, 105, 218)',
    preview: 'rgb(9, 105, 218)',
    sourceRuby: 'rgb(9, 105, 218)',
    liveRuby: 'rgb(9, 105, 218)',
    previewRuby: 'rgb(9, 105, 218)',
    sourcePlain: 'rgb(36, 41, 47)',
    livePlain: 'rgb(36, 41, 47)',
    previewPlain: 'rgb(36, 41, 47)'
  };
  if (JSON.stringify(unifiedLightCodePalette) !== JSON.stringify(expectedUnifiedLight)) {
    throw new Error(`Light code palette diverged across modes: ${JSON.stringify(unifiedLightCodePalette)}`);
  }

  const sequentialPlainCodePalette = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const previousEditor = (window as any).__nativePaletteEditor;
    previousEditor.destroy();
    const parent = document.getElementById('app')!;
    parent.replaceChildren();
    const text = Array.from({ length: 18 }, (_, index) => [
      '```',
      `plainSequenceToken${String(index).padStart(2, '0')}`,
      ...Array.from(
        { length: 80 },
        (_, line) => `plain payload ${String(index).padStart(2, '0')}-${String(line).padStart(2, '0')}`
      ),
      '```',
      ''
    ]).flat().join('\n');
    const editor = harness.createEditor({
      parent,
      text: '# Loading fixture',
      initialMode: 'source',
      onApplyChanges() {}
    });
    editor.setText(text);
    const visualColorForText = (needle: string): { color: string; fill: string } | null => {
      const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(needle)) {
          const style = getComputedStyle(node.parentElement ?? editor.view.dom);
          return { color: style.color, fill: style.webkitTextFillColor };
        }
      }
      return null;
    };
    const collect = async (): Promise<({ color: string; fill: string } | null)[]> => {
      const colors: ({ color: string; fill: string } | null)[] = [];
      for (let index = 0; index < 18; index += 1) {
        const sequenceMarker = `plainSequenceToken${String(index).padStart(2, '0')}`;
        const position = text.indexOf(sequenceMarker);
        editor.scrollToLine(editor.view.state.doc.lineAt(position).number, 'center');
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        colors.push(visualColorForText(sequenceMarker));
      }
      return colors;
    };
    const farToken = 'plainSequenceToken17';
    const farPosition = text.indexOf(farToken);
    editor.scrollToLine(editor.view.state.doc.lineAt(farPosition).number, 'center');
    let firstFarPaint = visualColorForText(farToken);
    if (!firstFarPaint) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      firstFarPaint = visualColorForText(farToken);
    }
    const source = await collect();
    editor.setMode('live');
    const live = await collect();
    editor.destroy();
    return { firstFarPaint, source, live };
  });
  const expectedPlainSequence = Array.from(
    { length: 18 },
    () => ({ color: 'rgb(36, 41, 47)', fill: 'rgb(36, 41, 47)' })
  );
  if (
    JSON.stringify(sequentialPlainCodePalette.firstFarPaint) !== JSON.stringify(expectedPlainSequence[0]) ||
    JSON.stringify(sequentialPlainCodePalette.source) !== JSON.stringify(expectedPlainSequence) ||
    JSON.stringify(sequentialPlainCodePalette.live) !== JSON.stringify(expectedPlainSequence)
  ) {
    throw new Error(
      `Sequential plain code blocks diverged after virtual scrolling: ${JSON.stringify(sequentialPlainCodePalette)}`
    );
  }

  const liveViewportHighlight = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const parent = document.getElementById('app')!;
    parent.replaceChildren();
    const text = ['```typescript', 'const firstValue = 73193;', '```',
      ...Array.from({ length: 300 }, () => 'A paragraph between supported code blocks.\n'),
      '```typescript', 'const lastValue = 83193;', '```'].join('\n');
    const editor = harness.createEditor({ parent, text, initialMode: 'live', onApplyChanges() {} });
    const readColor = (number: string) => {
      const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent === number) return getComputedStyle(node.parentElement!).color;
      }
      return null;
    };
    const observations: string[] = [];
    try {
      for (const color of ['#55aa55', '#cc4444']) {
        harness.setShikiTheme({ name: 'viewport', type: 'dark', colors: { 'editor.foreground': '#eeeeee' },
          tokenColors: [{ scope: 'constant.numeric', settings: { foreground: color } }] });
        for (const number of ['73193', '83193', '73193']) {
          editor.scrollToLine(editor.view.state.doc.lineAt(text.indexOf(number)).number, 'center');
          const expected = color === '#55aa55' ? 'rgb(85, 170, 85)' : 'rgb(204, 68, 68)';
          for (let attempt = 0; attempt < 200 && readColor(number) !== expected; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          observations.push(readColor(number) ?? 'missing');
        }
      }
    } finally { editor.destroy(); }
    return observations;
  });
  if (JSON.stringify(liveViewportHighlight) !== JSON.stringify([
    ...Array(3).fill('rgb(85, 170, 85)'), ...Array(3).fill('rgb(204, 68, 68)')
  ])) throw new Error(`Live viewport/theme highlight failed: ${JSON.stringify(liveViewportHighlight)}`);

  const viewportHighlight = await page.evaluate(async () => {
    const harness = (window as any).HighlightHarness;
    const release = harness.activateShikiCodeHighlighting('preview');
    const block = document.createElement('pre');
    block.style.cssText = 'position:fixed;top:100000px;left:0';
    block.innerHTML = '<code class="hljs language-typescript"><span class="meo-export-code-line-source">const viewportOnlyProbe = 927461;</span></code>';
    document.body.append(block);
    const line = block.querySelector<HTMLElement>('.meo-export-code-line-source')!;
    try {
      for (let i = 0; i < 20; i += 1) {
        harness.applyPreviewCodeHighlight(document, true);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const offscreenDeferred = !line.dataset.meoShiki;
      block.style.top = '0';
      for (let i = 0; i < 200 && !line.dataset.meoShiki; i += 1) {
        harness.applyPreviewCodeHighlight(document, true);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { offscreenDeferred, visibleColored: !!line.dataset.meoShiki,
        text: line.textContent };
    } finally {
      block.remove();
      release();
    }
  });
  if (!viewportHighlight.offscreenDeferred || !viewportHighlight.visibleColored
    || viewportHighlight.text !== 'const viewportOnlyProbe = 927461;') {
    throw new Error(`Preview viewport highlighting failed: ${JSON.stringify(viewportHighlight)}`);
  }

  console.log('Highlight syntax test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
