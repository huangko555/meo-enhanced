import { launchTestBrowser } from './browser-test-helpers';
import { buildExportStyles } from '../src/export/exportStyles';

const styles = buildExportStyles({
  previewFontFamily: '',
  editorBackgroundColor: '#ffffff',
  editorForegroundColor: '#1f2328',
  codeBlockBackgroundColor: '#f6f8fa',
  sideBarBackgroundColor: '#f6f8fa',
  panelBorderColor: '#d0d7de'
}, 'light');

const unbroken = '6'.repeat(160);
const browser = await launchTestBrowser();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html data-meo-export-target="pdf">
      <head><style>${styles}</style></head>
      <body data-meo-export-target="pdf">
        <div class="meo-export-page"><main class="meo-export-doc">
          <h3 class="heading">H3${unbroken}</h3>
          <p class="paragraph">P${unbroken}</p>
          <ul><li class="list-item">L${unbroken}</li></ul>
          <blockquote class="quote">Q${unbroken}</blockquote>
          <p class="link"><a href="https://example.com">A${unbroken}</a></p>
          <p class="inline-code"><code>C${unbroken}</code></p>
        </main></div>
      </body>
    </html>`);

  const layout = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.meo-export-doc');
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Missing overflow fixture: ${selector}`);
      }
      const computed = getComputedStyle(element);
      return {
        selector,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(computed.lineHeight),
        overflowWrap: computed.overflowWrap,
        wordBreak: computed.wordBreak
      };
    };

    return {
      rootClientWidth: root?.clientWidth ?? 0,
      rootScrollWidth: root?.scrollWidth ?? 0,
      blocks: ['.heading', '.paragraph', '.list-item', '.quote', '.link', '.inline-code'].map(read)
    };
  });

  const overflowing = layout.blocks.filter((block) => block.scrollWidth > block.clientWidth + 1);
  const unwrapped = layout.blocks.filter((block) => block.height <= block.lineHeight * 1.5);
  const incorrectPolicy = layout.blocks.filter(
    (block) => block.overflowWrap !== 'anywhere' || block.wordBreak !== 'normal'
  );

  if (
    layout.rootScrollWidth > layout.rootClientWidth + 1 ||
    overflowing.length > 0 ||
    unwrapped.length > 0 ||
    incorrectPolicy.length > 0
  ) {
    throw new Error(`Export content overflowed the reading surface: ${JSON.stringify(layout)}`);
  }

  console.log('Export content overflow checks passed');
} finally {
  await browser.close();
}
