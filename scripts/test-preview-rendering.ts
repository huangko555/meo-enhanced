import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildExportStyles, buildPreviewStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const rendered = renderMarkdownToHtml({
  markdownText: '# Intro\n\nParagraph\n\n```ts\nconst value = 1;\n```\n\n## Details\n\n# Intro',
  markdownFilePath: 'C:/tmp/preview.md',
  target: 'html'
});
const looseTable = renderMarkdownToHtml({
  markdownText: [
    '| Type | | Type | | | Content | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| Link | | | [VS Code](https://code.visualstudio.com/) | #table/tag |',
    '| Style | | | **Bold** and *italic* | `inline code` |'
  ].join('\n'),
  markdownFilePath: 'C:/tmp/preview-table.md',
  target: 'html'
});
const tableCellList = renderMarkdownToHtml({
  markdownText: '| Items |\n| --- |\n| - Apple<br>- Banana |',
  markdownFilePath: 'C:/tmp/preview-table-list.md',
  target: 'html'
});
const bodyBreakList = renderMarkdownToHtml({
  markdownText: '- Apple<br>- Banana',
  markdownFilePath: 'C:/tmp/preview-body-list.md',
  target: 'html'
});
const adjacentTable = renderMarkdownToHtml({
  markdownText: 'Intro\n| A |\n| --- |\n| value |\n## Target',
  markdownFilePath: 'C:/tmp/preview-adjacent-table.md',
  target: 'html'
});
const transformedSources = renderMarkdownToHtml({
  markdownText: '---\ntitle: Test\n---\nReference[^note]\n\n[^note]: Footnote\n\n## Target',
  markdownFilePath: 'C:/tmp/preview-source-map.md',
  target: 'html'
});
const rawHtmlUnderline = renderMarkdownToHtml({
  markdownText: 'Before <u>underlined</u> after',
  markdownFilePath: 'C:/tmp/preview-html-underline.md',
  target: 'html'
});
const nestedIndentedTable = renderMarkdownToHtml({
  markdownText: [
    '- Parent list item',
    '',
    '  | Name | Value |',
    '| --- | --- |',
    '| Alpha | One |',
    '| Beta | Two |'
  ].join('\n'),
  markdownFilePath: 'C:/tmp/preview-indented-table.md',
  target: 'html'
});
const standaloneIndentedTable = renderMarkdownToHtml({
  markdownText: [
    '  | Name | Value |',
    '  | --- | --- |',
    '  | Alpha | One |'
  ].join('\n'),
  markdownFilePath: 'C:/tmp/preview-standalone-indented-table.md',
  target: 'html'
});
const propertiesFrontmatter = renderMarkdownToHtml({
  markdownText: [
    '---',
    'title: Properties preview',
    'tags: [Markdown, Editor]',
    'metadata:',
    '  owner: Example',
    '  notes: |',
    '    Keep: this nested YAML content.',
    '  - https://example.com/docs',
    '"a:b": quoted key',
    '# Preserve comments',
    '---',
    '# Body'
  ].join('\n'),
  markdownFilePath: 'C:/tmp/preview-properties.md',
  target: 'html'
});
const tableLikeCode = renderMarkdownToHtml({
  markdownText: '```text\n| A | B |\n| --- |\n```',
  markdownFilePath: 'C:/tmp/preview-table-code.md',
  target: 'html'
});
const nestedCodeBlock = renderMarkdownToHtml({
  markdownText: '- Nested code:\n\n  ```javascript\n  const nested = true;\n  ```',
  markdownFilePath: 'C:/tmp/preview-nested-code.md',
  target: 'html'
});
const math = renderMarkdownToHtml({
  markdownText: [
    '行内公式：$E = mc^2$，$a^2 + b^2 = c^2$',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}',
    '',
    '$$',
    '',
    '```latex',
    '$$',
    '\\iiint_V',
    '$$',
    '```'
  ].join('\n'),
  markdownFilePath: 'C:/tmp/preview-math.md',
  target: 'html'
});
const formulaCoverageExpressions = [
  '\\frac{a}{b}',
  '\\sqrt{x}',
  '\\sum_{i=1}^{n} i',
  '\\prod_{k=1}^{n} k',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x}',
  '\\mathbf{A} + \\mathbb{R}',
  '\\vec{v} \\cdot \\hat{n}',
  '\\left\\lVert x \\right\\rVert',
  '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
  '\\alpha + \\beta + \\gamma + \\Delta + \\Omega'
];
const formulaCoverage = renderMarkdownToHtml({
  markdownText: formulaCoverageExpressions.map((expression) => `$${expression}$`).join('  '),
  markdownFilePath: 'C:/tmp/preview-math-coverage.md',
  target: 'html'
});

if (!rendered.html.includes('id="intro"') || !rendered.html.includes('id="intro-2"')) {
  throw new Error('Preview headings must receive stable, unique anchors');
}
if (!rendered.html.includes('data-source-line="1"') || !rendered.html.includes('data-source-line="9"')) {
  throw new Error('Preview headings must retain source lines for outline navigation');
}
if (!rendered.html.includes('<p data-source-line="3" data-source-end-line="3">Paragraph</p>')) {
  throw new Error('Preview blocks must retain source lines for viewport preservation');
}
if (!rendered.html.includes('data-source-line="5"') || !rendered.html.includes('data-source-end-line="7"')) {
  throw new Error('Preview fenced blocks must retain source lines for viewport preservation');
}
if (!looseTable.html.includes('<table')) {
  throw new Error('Preview must apply the same tolerant table recognition as Live mode');
}
if (!looseTable.html.includes('<div class="meo-table-scroll">')) {
  throw new Error('Preview tables must render inside an overflow container');
}
if (!tableCellList.html.includes('<ul') || !tableCellList.html.includes('<li>Apple</li>')) {
  throw new Error('Preview table cells must render break-separated Markdown lists');
}
if (!bodyBreakList.html.includes('<ul') || !bodyBreakList.html.includes('>Apple</li>')) {
  throw new Error('Preview paragraphs must render break-separated Markdown lists');
}
if (!adjacentTable.html.includes('<h2 data-source-line="5"')) {
  throw new Error('Preview source positions must refer to original Markdown lines after compatibility normalization');
}
if (!transformedSources.html.includes('<h2 data-source-line="8"')) {
  throw new Error('Preview source positions must survive frontmatter and footnote extraction');
}
if (!transformedSources.html.includes('class="meo-export-frontmatter" data-source-line="1" data-source-end-line="3"')) {
  throw new Error('Preview frontmatter must participate in viewport position mapping');
}
if (!rawHtmlUnderline.html.includes('<u>underlined</u>')) {
  throw new Error(`Preview must preserve safe HTML underline tags: ${rawHtmlUnderline.html}`);
}
if (
  !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-header"')
  || !propertiesFrontmatter.html.includes('>Properties<')
  || !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-line is-property"')
  || !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-key">title</span>')
  || !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-pill">Markdown</span>')
) {
  throw new Error('Preview frontmatter must render an Obsidian-style Properties layout');
}
if (
  !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-line is-raw"')
  || !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-line is-raw">    Keep: this nested YAML content.</div>')
  || !propertiesFrontmatter.html.includes('https://example.com/docs')
  || !propertiesFrontmatter.html.includes('class="meo-export-frontmatter-key">"a:b"</span>')
  || !propertiesFrontmatter.html.includes('# Preserve comments')
) {
  throw new Error('Preview Properties must preserve complex and unstructured YAML lines');
}
if (!transformedSources.html.includes('class="footnotes" data-source-line="6" data-source-end-line="7"')) {
  throw new Error('Preview footnotes must participate in viewport position mapping');
}
if (!tableLikeCode.html.includes('| --- |') || tableLikeCode.html.includes('| --- | --- |')) {
  throw new Error('Preview table compatibility must not rewrite fenced code');
}
if (
  !nestedIndentedTable.html.includes('<table')
  || !/<li\b[^>]*>[\s\S]*class="meo-table-scroll"[\s\S]*<table[\s\S]*<\/li>/.test(nestedIndentedTable.html)
  || nestedIndentedTable.html.includes('meo-export-indented-table')
  || nestedIndentedTable.html.includes('| Name | Value |')
) {
  throw new Error('Preview must keep a list-indented Markdown table aligned inside its list item');
}
if (
  !standaloneIndentedTable.html.includes('<table')
  || !standaloneIndentedTable.html.includes('class="meo-table-scroll meo-export-indented-table"')
  || !standaloneIndentedTable.html.includes('style="--meo-table-indent:2ch"')
) {
  throw new Error('Preview must preserve standalone indented Markdown tables');
}
if (
  nestedCodeBlock.html.includes('<pre><code')
  || (nestedCodeBlock.html.match(/<pre\b/g) ?? []).length !== 1
  || !nestedCodeBlock.html.includes('<div class="meo-export-code-block-wrap" data-source-line="3"')
  || !/<li\b[^>]*>[\s\S]*<div class="meo-export-code-block-wrap"[\s\S]*<\/li>/.test(nestedCodeBlock.html)
) {
  throw new Error('Preview nested code fences must render as one valid custom code block');
}
if (
  !math.html.includes('class="meo-export-math meo-export-math-inline"') ||
  !math.html.includes('class="meo-export-math meo-export-math-display meo-export-math-fenced-display"') ||
  (math.html.match(/class="katex/g) ?? []).length < 3 ||
  !math.html.includes('preserveAspectRatio="xMinYMin slice"') ||
  math.html.includes('$$') ||
  math.html.includes('class="language-latex"') ||
  math.html.includes('\\iiint_V')
) {
  throw new Error('Preview math must render inline, display, and latex fenced formulas with KaTeX');
}
if (
  formulaCoverageExpressions.some((expression) => formulaCoverage.html.includes(expression)) ||
  (formulaCoverage.html.match(/class="katex/g) ?? []).length < formulaCoverageExpressions.length
) {
  throw new Error('Preview math coverage must render common fractions, roots, operators, accents, matrices, and symbols');
}

const environment = {
  editorBackgroundColor: '#20252b',
  editorForegroundColor: '#d8dee9',
  codeBlockBackgroundColor: '#171b20',
  sideBarBackgroundColor: '#252b32',
  panelBorderColor: '#474b50'
};
const darkPreviewStyles = buildPreviewStyles(defaultThemeSettings, environment, 'dark');
const lightPreviewStyles = buildPreviewStyles(defaultThemeSettings, environment, 'light');
const exportStyles = buildExportStyles(defaultThemeSettings, environment, 'light');
const darkExportStyles = buildExportStyles(defaultThemeSettings, environment, 'dark');

if (!/h1, h2\s*\{[^}]*padding-bottom:\s*0\.3em;[^}]*border-bottom:\s*1px solid var\(--meo-hr\);/s.test(darkPreviewStyles)) {
  throw new Error('Preview level-one and level-two headings must render the shared divider line');
}
if (!/u\s*\{[^}]*text-decoration:\s*underline;/s.test(darkPreviewStyles)) {
  throw new Error('Preview and export styles must render HTML underline tags');
}
if (!/h1, h2\s*\{[^}]*padding-bottom:\s*0\.3em;[^}]*border-bottom:\s*1px solid var\(--meo-hr\);/s.test(exportStyles)) {
  throw new Error('Export headings must match the Preview divider line');
}
if (exportStyles !== lightPreviewStyles || darkExportStyles !== darkPreviewStyles) {
  throw new Error('Export and Preview must share one reading stylesheet for the same appearance');
}

if (
  !darkPreviewStyles.includes('--meo-heading-1-size: 1.6em') ||
  !darkPreviewStyles.includes('--meo-heading-1-weight: 400') ||
  !darkPreviewStyles.includes('strong { color: var(--meo-strong); font-weight: 700; }')
) {
  throw new Error('Preview headings and strong text must use the same explicit theme typography as Live mode');
}

if (!darkPreviewStyles.includes('--meo-bg: #20252b')) {
  throw new Error('Dark Preview must use the current document background');
}
for (const expected of [
  '--meo-fg: #d8dee9',
  '--meo-heading: #d8dee9',
  '--meo-strong: #d8dee9',
  '--meo-link: #d8dee9'
]) {
  if (!darkPreviewStyles.includes(expected)) {
    throw new Error(`Dark Preview must use its neutral reading palette: ${expected}`);
  }
}
if (darkPreviewStyles.includes('#171b20')) {
  throw new Error('Dark Preview must not inherit the editor code-block palette');
}
if (!lightPreviewStyles.includes('--meo-bg: #ffffff')) {
  throw new Error('Light Preview must use a white reading background');
}
if (!lightPreviewStyles.includes('--meo-link: #1f2328')) {
  throw new Error('Light Preview links must use the neutral reading foreground');
}
if (!darkPreviewStyles.includes('padding-inline-start: 1.5em')) {
  throw new Error('Preview lists must retain readable indentation in documents and table cells');
}
if (
  !/\.meo-table-scroll\s*\{[^}]*\bwidth:\s*100%;/s.test(darkPreviewStyles) ||
  /\.meo-table-scroll\s*\{[^}]*\bwidth:\s*max-content;/s.test(darkPreviewStyles)
) {
  throw new Error('Preview tables must fit the reading surface without relying on horizontal scrolling');
}
if (!exportStyles.includes('--meo-bg: #ffffff')) {
  throw new Error('Light Preview exports must use the white Meo Reading background');
}
if (!darkExportStyles.includes('--meo-bg: #20252b')) {
  throw new Error('Dark Preview exports must keep the active dark reading background');
}
if (!exportStyles.includes('max-width: 900px')) {
  throw new Error('Meo Reading must constrain HTML documents to a readable measure');
}
if (!exportStyles.includes('.meo-table-scroll') || !exportStyles.includes('overflow-wrap: anywhere')) {
  throw new Error('HTML and PDF exports must fit wide tables to the printable reading surface');
}

console.log('Preview rendering tests passed');
