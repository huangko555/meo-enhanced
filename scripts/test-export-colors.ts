import exportRuntime from '../src/export/runtime';
import { launchTestBrowser } from './browser-test-helpers';

const rendered = await exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'export-colors',
    text: '# Heading\n\n**Bold**\n\n*Italic*\n\n~~Deleted~~\n\n`Code`\n\n[Link](https://example.com)\n\n[Linked `code`](https://example.com/code)',
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
  title: 'Dark export colors'
});

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
  const readColors = () => page.evaluate(() => {
    const normalizeColor = (value: string) => {
      const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/i.exec(value);
      return srgb
        ? `rgb(${srgb.slice(1).map((channel) => Math.round(Number(channel) * 255)).join(', ')})`
        : value;
    };
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? normalizeColor(getComputedStyle(element).color) : `missing:${selector}`;
    };
    return {
      heading: read('h1'),
      strong: read('strong'),
      emphasis: read('em'),
      deleted: read('s, del'),
      code: read('p > code'),
      link: read('a'),
      linkedCode: read('a code')
    };
  });
  const htmlColors = await readColors();
  await page.evaluate(() => {
    document.documentElement.dataset.meoExportTarget = 'pdf';
    document.body.dataset.meoExportTarget = 'pdf';
  });
  const pdfColors = await readColors();
  const expectedColors = {
    heading: 'rgb(216, 222, 233)',
    strong: 'rgb(191, 199, 210)',
    emphasis: 'rgb(191, 199, 210)',
    deleted: 'rgb(191, 199, 210)',
    code: 'rgb(191, 199, 210)',
    link: 'rgb(88, 166, 255)',
    linkedCode: 'rgb(88, 166, 255)'
  };
  for (const [target, colors] of Object.entries({ html: htmlColors, pdf: pdfColors })) {
    for (const [kind, color] of Object.entries(colors) as Array<[keyof typeof expectedColors, string]>) {
      const expectedColor = expectedColors[kind];
      if (color !== expectedColor) {
        throw new Error(`Dark ${target} export ${kind} did not inherit the Preview palette: ${color}`);
      }
    }
  }
  console.log('Dark export color test passed');
} finally {
  await browser.close();
}
