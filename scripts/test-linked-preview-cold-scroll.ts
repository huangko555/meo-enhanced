import assert from 'node:assert/strict';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, captureResult, assertStablePaint } from './input-presentation-test-helpers';

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
const wideHeader = '| ID | Identifier | Category | Source | Created | Updated | Version | Description |';
const tail = ['# Reading at a table boundary', '', '| Record | Value | Status | Description |', '| --- | ---: | :---: | --- |',
  ...Array.from({ length: 32 }, (_, index) => `| TABLE-${index} | ${2401 + index} | normal | Synthetic description ${index}, **emphasis**, \`row_${index}\`, $x+${index}$ |`),
  '', 'After table reading witness.', '', wideHeader, '| ---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  `| 24 | ${'long_identifier_abcdefghijklmnopqrstuvwxyz0123456789_'.repeat(7)} | metadata | SOURCE_PLACEHOLDER | 2028-04-01 | 2028-04-02 | 1.2.3 | ${'Long description with wrapping text. '.repeat(5)} |`,
  '', '- First following item.', '- **Formatted** following item.', '', 'Following paragraph.\n\n'.repeat(80)].join('\n');
const text = sections.join('\n') + '\n\n' + tail;
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
    for (const ratio of process.argv.includes('--tail-only') ? [] : [.35, .8, .55]) {
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
    if (!process.argv.includes('--tail-only')) {
      const previewPoint = await page.$eval('.preview-frame', element => {
        const r = element.getBoundingClientRect(); return { x: r.right - 25, y: r.top + r.height / 2 };
      });
      const beforeReverse = await page.$eval('.editor-host .cm-scroller', element => element.scrollTop);
      await page.mouse.move(previewPoint.x, previewPoint.y); await page.mouse.wheel({ deltaY: 650 });
      await pause(1000);
      const afterReverse = await page.$eval('.editor-host .cm-scroller', element => element.scrollTop);
      assert.ok(Math.abs(afterReverse - beforeReverse) > 100, 'Preview scrolling must take ownership and move Source');
    }
    assert.equal(await page.$eval('.editor-host .cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text);
    const editFrom = text.indexOf(wideHeader) + 4;
    for (const sync of [true, false]) {
      if (await page.$eval('.source-preview-scroll-sync-button', e => e.getAttribute('aria-pressed') === 'true') !== sync) {
        await page.locator('.source-preview-scroll-sync-button').click();
      }
      const sourcePoint = await page.$eval('.editor-host .cm-scroller', element => {
        const r = element.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 60 };
      });
      await page.mouse.click(sourcePoint.x, sourcePoint.y);
      await page.evaluate(from => {
        const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        v.dispatch({ selection: { anchor: from }, scrollIntoView: true }); v.focus();
      }, editFrom);
      await pause(600);
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(() => {
          const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          v.scrollDOM.scrollTop += v.coordsAtPos(v.state.selection.main.head).top - v.scrollDOM.getBoundingClientRect().top - 120;
        }); await pause(250);
      }
      await pause(1200);
      const clip = await page.evaluate(() => {
        const scope = window as any, frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const d = frame.contentDocument!, witness = [...d.querySelectorAll('p')].find(e => e.textContent === 'After table reading witness.')!;
        const r = witness?.getBoundingClientRect();
        if (!r || r.top < 0 || r.bottom > d.defaultView!.innerHeight) throw new Error(`Table boundary witness must be visible: ${r?.top}`);
        scope.__tailSamples = []; scope.__presentationFrames = scope.__tailSamples; scope.__tailSampling = true;
        const read = () => {
          if (!scope.__tailSampling) return;
          scope.__tailSamples.push({ top: witness.getBoundingClientRect().top, connected: witness.isConnected,
            scroll: d.scrollingElement!.scrollTop });
          requestAnimationFrame(read);
        }; read();
        const f = frame.getBoundingClientRect();
        return { left: Math.ceil(f.left + r.left), top: Math.ceil(f.top + r.top), width: Math.floor(r.width - 1), height: Math.floor(r.height - 1) };
      });
      await assertStablePaint(page, clip, async () => { await page.keyboard.type('1'); await pause(8000); }, `table-boundary handoff sync ${sync}`);
      const samples = await page.evaluate(() => { const s = window as any; s.__tailSampling = false;
        return s.__tailSamples as Array<{ top: number; connected: boolean; scroll: number }>; });
      assert.ok(samples.length > 30 && samples.every(sample => sample.connected), 'keep the accepted table-tail DOM throughout handoff');
      assert.ok(Math.max(...samples.map(sample => sample.top)) - Math.min(...samples.map(sample => sample.top)) <= 1,
        'editing below a tall reading block must not move its following paragraph');
      assert.equal(host.readHost(), text.slice(0, editFrom) + '1' + text.slice(editFrom));
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await pause(900);
      assert.equal(host.readHost(), text, 'undo exactly the boundary edit');
    }
    const samples = await page.evaluate(() => { const s = window as any; s.__coldScrollSampling = false; return s.__coldScrollSamples as boolean[]; });
    assert.ok(samples.length > 30 && samples.every(Boolean), 'cold destinations must keep a reading band painted');
    await captureResult(page, 'linked-preview-cold-scroll');
    assert.deepEqual(host.errors, []);
    console.log('Windowed linked Preview: source anchors, reverse scrolling and stable table-tail edit handoffs passed');
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
