import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';

const markdown = [
  '# Heading `code` **bold `code`** *italic `code`* ~~deleted `code`~~',
  '',
  '```javascript',
  'const rounded = true;',
  '```',
  '',
  '$$',
  'x^2 + y^2 = z^2',
  '$$'
].join('\n');
const rendered = renderMarkdownToHtml({
  markdownText: markdown,
  markdownFilePath: 'C:/tmp/preview-layout.md',
  target: 'html'
});
const styles = buildPreviewStyles({
  editorBackgroundColor: '#20252b',
  editorForegroundColor: '#d8dee9',
  codeBlockBackgroundColor: '#171b20',
  sideBarBackgroundColor: '#252b32',
  panelBorderColor: '#474b50'
}, 'dark');

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
  await page.setContent(`<style>${styles}</style><div class="meo-export-page"><main class="meo-export-doc">${rendered.html}</main></div>`);
  const layout = await page.evaluate(() => {
    const heading = document.querySelector<HTMLHeadingElement>('h1');
    const headingCodes = Array.from(heading?.querySelectorAll<HTMLElement>('code') ?? []);
    const codeBlock = document.querySelector<HTMLElement>('pre.meo-export-code-block');
    const mathBlock = document.querySelector<HTMLElement>('.meo-export-math-fenced-display');
    return {
      headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      codeFontSizes: headingCodes.map((code) => Number.parseFloat(getComputedStyle(code).fontSize)),
      boldCodeWeight: headingCodes[1] ? Number.parseInt(getComputedStyle(headingCodes[1]).fontWeight, 10) : 0,
      italicCodeStyle: headingCodes[2] ? getComputedStyle(headingCodes[2]).fontStyle : '',
      deletedCodeDecoration: headingCodes[3] ? getComputedStyle(headingCodes[3]).textDecorationLine : '',
      codeBlockRadius: codeBlock ? getComputedStyle(codeBlock).borderRadius : '',
      mathBlockRadius: mathBlock ? getComputedStyle(mathBlock).borderRadius : ''
    };
  });
  if (
    layout.codeFontSizes.some((size) => Math.abs(size - layout.headingFontSize) > 0.5) ||
    layout.boldCodeWeight < 600 ||
    layout.italicCodeStyle !== 'italic' ||
    !layout.deletedCodeDecoration.includes('line-through') ||
    layout.codeBlockRadius !== '6px' ||
    layout.mathBlockRadius !== '6px'
  ) {
    throw new Error(`Unexpected Preview reading layout: ${JSON.stringify(layout)}`);
  }
  console.log('Preview layout checks passed');
} finally {
  await browser.close();
}
