import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const markdown = [
  '| No. | Product | Category | Owner | Created | Updated | Version | Notes |',
  '| ---: | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | VeryLongProductNameWithoutWhitespaceForColumnWidthTesting | Editor Extension | Example Owner | 2026-01-01 | 2026-07-10 | 2026.07.10-preview | This intentionally long description verifies readable column sizing. |',
  '',
  '| Items |',
  '| --- |',
  '| - Apple<br>  - Nested<br>- Banana |',
  '',
  '# Heading `code` **bold `code`** *italic `code`* ~~deleted `code`~~'
].join('\n');
const rendered = renderMarkdownToHtml({
  markdownText: markdown,
  markdownFilePath: 'C:/tmp/preview-layout.md',
  target: 'html'
});
const styles = buildPreviewStyles(defaultThemeSettings, {
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
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.meo-table-scroll'));
    const wideTable = wrappers[0]?.querySelector<HTMLTableElement>('table');
    const list = wrappers[1]?.querySelector<HTMLUListElement>('ul');
    const listCell = list?.closest<HTMLTableCellElement>('td');
    const heading = document.querySelector<HTMLHeadingElement>('h1');
    const headingCodes = Array.from(heading?.querySelectorAll<HTMLElement>('code') ?? []);
    return {
      wrapperWidth: wrappers[0]?.clientWidth ?? 0,
      wrapperScrollWidth: wrappers[0]?.scrollWidth ?? 0,
      tableWidth: wideTable?.getBoundingClientRect().width ?? 0,
      columnWidths: wideTable
        ? Array.from(wideTable.rows[0]?.cells ?? []).map((cell) => cell.getBoundingClientRect().width)
        : [],
      listPadding: list ? Number.parseFloat(getComputedStyle(list).paddingInlineStart) : 0,
      cellPadding: listCell ? Number.parseFloat(getComputedStyle(listCell).paddingInlineStart) : 0,
      listCellFound: Boolean(listCell),
      headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      codeFontSizes: headingCodes.map((code) => Number.parseFloat(getComputedStyle(code).fontSize)),
      boldCodeWeight: headingCodes[1] ? Number.parseInt(getComputedStyle(headingCodes[1]).fontWeight, 10) : 0,
      italicCodeStyle: headingCodes[2] ? getComputedStyle(headingCodes[2]).fontStyle : '',
      deletedCodeDecoration: headingCodes[3] ? getComputedStyle(headingCodes[3]).textDecorationLine : ''
    };
  });
  if (
    layout.wrapperWidth <= 0 ||
    layout.wrapperScrollWidth > layout.wrapperWidth + 1 ||
    layout.tableWidth > layout.wrapperWidth + 1 ||
    !layout.listCellFound ||
    layout.listPadding < 24 ||
    layout.cellPadding < 12 ||
    layout.codeFontSizes.some((size) => Math.abs(size - layout.headingFontSize) > 0.5) ||
    layout.boldCodeWeight < 600 ||
    layout.italicCodeStyle !== 'italic' ||
    !layout.deletedCodeDecoration.includes('line-through')
  ) {
    throw new Error(`Unexpected Preview reading layout: ${JSON.stringify(layout)}`);
  }
  console.log('Preview layout checks passed');
} finally {
  await browser.close();
}
