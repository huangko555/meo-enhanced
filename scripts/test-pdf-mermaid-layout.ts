import { launchTestBrowser } from './browser-test-helpers';
import { buildExportStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const styles = buildExportStyles(defaultThemeSettings, {
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
        </main></div>
      </body>
    </html>`);

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
      wide: read('.wide svg')
    };
  });

  const tallRatio = layout.tall.width / layout.tall.height;
  const expectedRatio = 482 / 1734;
  if (
    Math.abs(layout.short.height - 70) > 1 ||
    layout.tall.height > 950 ||
    Math.abs(tallRatio - expectedRatio) > 0.01 ||
    layout.wide.width > layout.documentWidth + 1
  ) {
    throw new Error(`Unexpected PDF Mermaid layout: ${JSON.stringify(layout)}`);
  }

  console.log('PDF Mermaid layout checks passed');
} finally {
  await browser.close();
}
