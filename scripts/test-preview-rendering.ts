import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildExportStyles, buildPreviewStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const rendered = renderMarkdownToHtml({
  markdownText: '# Intro\n\nParagraph\n\n```ts\nconst value = 1;\n```\n\n## Details\n\n# Intro',
  markdownFilePath: 'C:/tmp/preview.md',
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

const environment = {
  editorBackgroundColor: '#20252b',
  editorForegroundColor: '#d8dee9',
  codeBlockBackgroundColor: '#171b20',
  sideBarBackgroundColor: '#252b32',
  panelBorderColor: '#474b50'
};
const darkPreviewStyles = buildPreviewStyles(defaultThemeSettings, environment, 'dark');
const lightPreviewStyles = buildPreviewStyles(defaultThemeSettings, environment, 'light');
const exportStyles = buildExportStyles(defaultThemeSettings, environment);

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
if (!exportStyles.includes('--meo-bg: #ffffff')) {
  throw new Error('Exports must always use the white Meo Reading palette');
}
if (!exportStyles.includes('max-width: 900px')) {
  throw new Error('Meo Reading must constrain HTML documents to a readable measure');
}

console.log('Preview rendering tests passed');
