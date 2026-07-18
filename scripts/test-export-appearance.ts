import exportRuntime from '../src/export/runtime';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const baseOptions = {
  markdownText: '# Export appearance\n\n```mermaid\nflowchart LR\nA --> B\n```',
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html' as const,
  htmlImageMode: 'embedded' as const,
  theme: defaultThemeSettings,
  styleEnvironment: {
    editorBackgroundColor: '#20252b',
    editorForegroundColor: '#d8dee9',
    codeBlockBackgroundColor: '#171b20',
    sideBarBackgroundColor: '#252b32',
    panelBorderColor: '#474b50'
  },
  mermaidRuntimeSrc: 'mermaid.min.js',
  baseHref: 'file:///C:/tmp/',
  title: 'Export appearance'
};

const light = exportRuntime.renderExportHtmlDocument({ ...baseOptions, appearance: 'light' });
const dark = exportRuntime.renderExportHtmlDocument({ ...baseOptions, appearance: 'dark' });

if (!light.htmlDocument.includes('--meo-bg: #ffffff')) {
  throw new Error('Light export did not build a white reading document');
}
if (!dark.htmlDocument.includes('--meo-bg: #20252b')) {
  throw new Error('Dark export did not build a dark reading document');
}
if (!light.hasMermaid || !dark.hasMermaid || light.htmlDocument === dark.htmlDocument) {
  throw new Error('Export rendering did not preserve Mermaid content across appearance variants');
}

console.log('export appearance checks passed');
