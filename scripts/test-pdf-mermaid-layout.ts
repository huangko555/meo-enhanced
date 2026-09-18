import { launchTestBrowser } from './browser-test-helpers';
import { buildExportStyles } from '../src/export/exportStyles';
import { preparePdfPagination } from '../src/export/pdfRenderer';

const styles = buildExportStyles({
  previewFontFamily: '',
  editorBackgroundColor: '#20252b',
  editorForegroundColor: '#d8dee9',
  codeBlockBackgroundColor: '#171b20',
  sideBarBackgroundColor: '#252b32',
  panelBorderColor: '#474b50'
}, 'dark');

const svg = (className: string, width: number, height: number) => `
  <div class="meo-export-mermaid is-rendered ${className}">
    <div class="meo-export-mermaid-svg">
      <svg viewBox="0 0 ${width} ${height}" style="max-width:${width}px" width="100%" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" fill="transparent" />
      </svg>
    </div>
  </div>`;

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html data-meo-export-target="pdf">
      <head><style>${styles}</style></head>
      <body data-meo-export-target="pdf">
        <div class="meo-export-page"><main class="meo-export-doc">
          ${svg('short', 408, 70)}
          ${svg('tall', 482, 1734)}
          ${svg('wide', 1734, 482)}
          <pre class="short-block" style="height:300px">short</pre>
          <pre class="long-block" style="height:650px">long</pre>
          <ul>
            <li class="simple-item">Simple item</li>
            <li class="complex-item"><blockquote>Complex item</blockquote></li>
          </ul>
          <h2 class="paired-heading">Paired diagram</h2>
          ${svg('paired', 482, 1734)}
        </main></div>
      </body>
    </html>`);

  await preparePdfPagination(page);

  const layout = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector<SVGSVGElement>(selector);
      const rect = element?.getBoundingClientRect();
      return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    };
    return {
      documentWidth: document.querySelector<HTMLElement>('.meo-export-doc')?.clientWidth ?? 0,
      short: read('.short svg'),
      tall: read('.tall svg'),
      wide: read('.wide svg'),
      paired: read('.paired svg'),
      shortBreakable: document.querySelector('.short-block')?.hasAttribute('data-meo-pdf-allow-break'),
      longBreakable: document.querySelector('.long-block')?.hasAttribute('data-meo-pdf-allow-break'),
      simpleItemBreakable: document.querySelector('.simple-item')?.hasAttribute('data-meo-pdf-allow-break'),
      complexItemBreakable: document.querySelector('.complex-item')?.hasAttribute('data-meo-pdf-allow-break'),
      pairedWithHeading: document.querySelector('.paired')?.hasAttribute('data-meo-pdf-heading-pair')
    };
  });

  const tallRatio = layout.tall.width / layout.tall.height;
  const expectedRatio = 482 / 1734;
  if (
    Math.abs(layout.short.height - 70) > 1 ||
    layout.tall.height > 950 ||
    Math.abs(tallRatio - expectedRatio) > 0.01 ||
    layout.wide.width > layout.documentWidth + 1 ||
    layout.paired.height > 900 ||
    layout.shortBreakable !== false ||
    layout.longBreakable !== true ||
    layout.simpleItemBreakable !== false ||
    layout.complexItemBreakable !== true ||
    layout.pairedWithHeading !== true
  ) {
    throw new Error(`Unexpected PDF Mermaid layout: ${JSON.stringify(layout)}`);
  }

  console.log('PDF Mermaid layout checks passed');
} finally {
  await browser.close();
}
