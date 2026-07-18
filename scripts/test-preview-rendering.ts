import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildExportStyles, buildPreviewStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const rendered = renderMarkdownToHtml({
  markdownText: '# Intro\n\n## Details\n\n# Intro',
  markdownFilePath: 'C:/tmp/preview.md',
  target: 'html'
});

if (!rendered.html.includes('id="intro"') || !rendered.html.includes('id="intro-2"')) {
  throw new Error('Preview headings must receive stable, unique anchors');
}
if (!rendered.html.includes('data-source-line="1"') || !rendered.html.includes('data-source-line="3"')) {
  throw new Error('Preview headings must retain source lines for outline navigation');
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
if (!lightPreviewStyles.includes('--meo-bg: #ffffff')) {
  throw new Error('Light Preview must use a white reading background');
}
if (!exportStyles.includes('--meo-bg: #ffffff')) {
  throw new Error('Exports must always use the white Meo Reading palette');
}
if (!exportStyles.includes('max-width: 900px')) {
  throw new Error('Meo Reading must constrain HTML documents to a readable measure');
}

console.log('Preview rendering tests passed');
