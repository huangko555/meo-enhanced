import exportRuntime from '../src/export/runtime';
import { defaultThemeSettings } from '../src/shared/themeDefaults';
import { launchTestBrowser } from './browser-test-helpers';

const rendered = exportRuntime.renderExportHtmlDocument({
  markdownText: '# Heading\n\n**Bold**\n\n*Italic*\n\n~~Deleted~~\n\n`Code`',
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
  title: 'Dark export colors'
});

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
  const readColors = () => page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).color : `missing:${selector}`;
    };
    return {
      heading: read('h1'),
      strong: read('strong'),
      emphasis: read('em'),
      deleted: read('s, del'),
      code: read('code')
    };
  });
  const htmlColors = await readColors();
  await page.evaluate(() => {
    document.documentElement.dataset.meoExportTarget = 'pdf';
    document.body.dataset.meoExportTarget = 'pdf';
  });
  const pdfColors = await readColors();
  const expected = 'rgb(216, 222, 233)';
  for (const [target, colors] of Object.entries({ html: htmlColors, pdf: pdfColors })) {
    for (const [kind, color] of Object.entries(colors)) {
      if (color !== expected) {
        throw new Error(`Dark ${target} export ${kind} color leaked from the editor theme: ${color}`);
      }
    }
  }
  console.log('Dark export color test passed');
} finally {
  await browser.close();
}
