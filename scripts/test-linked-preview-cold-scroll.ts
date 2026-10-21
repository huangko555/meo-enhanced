import assert from 'node:assert/strict';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, captureResult } from './input-presentation-test-helpers';

const sections: string[] = [];
for (let index = 0; index < 420; index++) sections.push([
  `# Section ${index}`, '',
  ...Array.from({ length: 3 }, (_, paragraph) => [
    `Paragraph ${index}-${paragraph}. ${'Mixed wrapping 中文 and **formatted** text. '.repeat(12 + index % 35)}`, ''
  ]).flat(),
  '| Record | Description |', '| --- | --- |',
  `| ${index} | ${'Table text with inline $x+1$. '.repeat(4)} |`, '',
  '```typescript', ...Array.from({ length: 12 }, (_, line) => `const item_${index}_${line} = ${line};`), '```', '',
  '> Quoted text.', '>', '> - A nested item.', '> - Another item.', '',
  '$$', `x_{${index}} = y^2 + 1`, '$$', ''
].join('\n'));
const text = sections.join('\n');
assert.ok(Buffer.byteLength(text) > 1_000_000);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let primary: unknown;
try {
  const page = await browser.newPage(), host = await open(page, text, true);
  try {
    await page.setViewport({ width: 780, height: 570 });
    await page.locator('.source-preview-button').click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line]'));
    await page.evaluate(() => {
      const s = window as any; s.__coldScrollSamples = []; s.__coldScrollSampling = true;
      const sample = () => {
        if (!s.__coldScrollSampling) return;
        const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        s.__coldScrollSamples.push([...d.querySelectorAll<HTMLElement>('[data-source-line]:not([data-meo-preview-gap])')]
          .some(element => { const r = element.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < d.defaultView!.innerHeight; }));
        requestAnimationFrame(sample);
      }; requestAnimationFrame(sample);
    });
    for (const ratio of [.35, .8, .55]) {
      // A native thumb can jump across an unmounted range in one scroll event.
      // Set the same scroll position directly; native dragging is accepted
      // separately in the isolated VS Code window, without the host mouse.
      await page.evaluate(ratio => {
        const s = document.querySelector('.editor-host .cm-scroller')!;
        s.scrollTop = (s.scrollHeight - s.clientHeight) * ratio;
      }, ratio);
      await pause(1800);
      const aligned = await page.evaluate(() => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const first = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
        let line = first;
        while (line < view.state.doc.lines && !view.state.doc.line(line).text.trim()) line++;
        const visible = [...d.querySelectorAll<HTMLElement>('[data-source-line]:not([data-meo-preview-gap])')]
          .filter(element => { const r = element.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < d.defaultView!.innerHeight; })
          .map(element => [Number(element.dataset.sourceLine), Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine)]);
        return { first, line, visible };
      });
      assert.ok(aligned.visible.some(([from, to]) => from! <= aligned.line && to! >= aligned.line),
        `Cold Source scroll ${ratio} missed its Preview destination: ${JSON.stringify(aligned)}`);
    }
    const previewPoint = await page.$eval('.preview-frame', element => {
      const r = element.getBoundingClientRect(); return { x: r.right - 25, y: r.top + r.height / 2 };
    });
    const beforeReverse = await page.$eval('.editor-host .cm-scroller', element => element.scrollTop);
    await page.mouse.move(previewPoint.x, previewPoint.y); await page.mouse.wheel({ deltaY: 650 });
    await pause(1000);
    const afterReverse = await page.$eval('.editor-host .cm-scroller', element => element.scrollTop);
    assert.ok(Math.abs(afterReverse - beforeReverse) > 100, 'Preview scrolling must take ownership and move Source');
    assert.equal(await page.$eval('.editor-host .cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text);
    const samples = await page.evaluate(() => { const s = window as any; s.__coldScrollSampling = false; return s.__coldScrollSamples as boolean[]; });
    assert.ok(samples.length > 30 && samples.every(Boolean), 'cold destinations must keep a reading band painted');
    await captureResult(page, 'linked-preview-cold-scroll');
    assert.deepEqual(host.errors, []);
    console.log('Windowed linked Preview: distant source anchors, painted handoffs and reverse scrolling passed');
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
