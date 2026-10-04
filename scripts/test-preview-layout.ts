import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';

const markdown = [
  '# Heading `code` **bold `code`** *italic `code`* ~~deleted `code`~~',
  '',
  '```text',
  '**literal**',
  '',
  '    <span>& value',
  '```',
  '',
  '    **literal**',
  '',
  '        <span>& value',
  '',
  '$$',
  'x^2 + y^2 = z^2',
  '$$',
  '',
  '| Left | Right |',
  '| --- | --- |',
  '| One | Two |'
].join('\n');
const rendered = renderMarkdownToHtml({
  markdownText: markdown,
  markdownFilePath: 'C:/tmp/preview-layout.md',
  target: 'html'
});
const styles = buildPreviewStyles({
  previewFontFamily: '',
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
    const codeBlocks = Array.from(document.querySelectorAll<HTMLElement>('pre.meo-export-code-block'));
    const codeBlock = codeBlocks[0];
    const indented = codeBlocks[1];
    const codeSelections = codeBlocks.map((block) => {
      const range = document.createRange();
      range.selectNodeContents(block.querySelector('code')!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    const mathBlock = document.querySelector<HTMLElement>('.meo-export-math-fenced-display');
    const tableCell = document.querySelector<HTMLTableCellElement>('td');
    const tableBorder = tableCell ? getComputedStyle(tableCell).borderTopColor : '';
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = tableBorder;
    context.fillRect(0, 0, 1, 1);
    return {
      headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      codeFontSizes: headingCodes.map((code) => Number.parseFloat(getComputedStyle(code).fontSize)),
      boldCodeWeight: headingCodes[1] ? Number.parseInt(getComputedStyle(headingCodes[1]).fontWeight, 10) : 0,
      italicCodeStyle: headingCodes[2] ? getComputedStyle(headingCodes[2]).fontStyle : '',
      deletedCodeDecoration: headingCodes[3] ? getComputedStyle(headingCodes[3]).textDecorationLine : '',
      codeBlockRadius: codeBlock ? getComputedStyle(codeBlock).borderRadius : '',
      codeBackground: codeBlock ? getComputedStyle(codeBlock).backgroundColor : '',
      codeFont: codeBlock ? getComputedStyle(codeBlock.querySelector('.meo-export-code-line-source')!).fontFamily : '',
      indentedBackground: indented ? getComputedStyle(indented).backgroundColor : '',
      indentedFont: indented ? getComputedStyle(indented.querySelector('.meo-export-code-line-source')!).fontFamily : '',
      indentedSourceLine: indented?.parentElement?.getAttribute('data-source-line'),
      indentedSources: Array.from(indented?.querySelectorAll('.meo-export-code-line-source') ?? []).map(line => line.textContent),
      indentedNumbers: Array.from(indented?.querySelectorAll('.meo-export-code-line-number') ?? []).map(line => line.getAttribute('data-line-number')),
      codeSelections,
      mathBlockRadius: mathBlock ? getComputedStyle(mathBlock).borderRadius : '',
      tableBorder,
      tableBorderAlpha: context.getImageData(0, 0, 1, 1).data[3]
    };
  });
  if (
    layout.codeFontSizes.some((size) => Math.abs(size - layout.headingFontSize) > 0.5) ||
    layout.boldCodeWeight < 600 ||
    layout.italicCodeStyle !== 'italic' ||
    !layout.deletedCodeDecoration.includes('line-through') ||
    layout.codeBlockRadius !== '6px' ||
    layout.mathBlockRadius !== '6px' ||
    layout.tableBorderAlpha !== 255
  ) {
    throw new Error(`Unexpected Preview reading layout: ${JSON.stringify(layout)}`);
  }
  if (layout.indentedBackground !== layout.codeBackground || layout.indentedBackground === 'rgba(0, 0, 0, 0)'
    || layout.indentedFont !== layout.codeFont || layout.indentedSourceLine !== '9'
    || JSON.stringify(layout.indentedSources) !== JSON.stringify(['**literal**', '', '    <span>& value'])
    || JSON.stringify(layout.indentedNumbers) !== JSON.stringify(['1', '2', '3'])
    || layout.codeSelections[1] !== layout.codeSelections[0]
    || layout.codeSelections[1].trimEnd() !== '**literal**\n\n    <span>& value') {
    throw new Error(`Indented Preview code must share fenced presentation and preserve selectable source: ${JSON.stringify(layout)}`);
  }
  await page.addStyleTag({ content: buildPreviewStyles({ previewFontFamily: '' }, 'light') });
  const lightCode = await page.$$eval('pre.meo-export-code-block', blocks => blocks.map(block => ({
    background: getComputedStyle(block).backgroundColor,
    font: getComputedStyle(block.querySelector('.meo-export-code-line-source')!).fontFamily
  })));
  if (lightCode.length !== 2 || lightCode[0].background !== lightCode[1].background
    || lightCode[1].background === 'rgba(0, 0, 0, 0)' || lightCode[0].font !== lightCode[1].font) {
    throw new Error(`Indented Preview code must retain shared presentation in light mode: ${JSON.stringify(lightCode)}`);
  }
  console.log('Preview layout checks passed, including indented code backgrounds, fonts, source mappings, literal content and selection without line numbers');
} finally {
  await browser.close();
}
