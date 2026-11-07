import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import type { Page } from 'puppeteer-core';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

type Sample = { scroll: number; height: number; head: number; top: number | null; bottom: number | null; viewportTop: number; viewportBottom: number; visibleContent: boolean };
let cases = 0, paintedFrames = 0, failure: unknown;
const shortcut = async (page: Page, key: string) => {
  await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control');
};

// Observe mounted DOM only. coordsAtPos/lineBlockAt can flush CodeMirror's
// pending measure and would change the ordering this contract needs to observe.
async function observeReveal(page: Page, label: string, action: () => Promise<void>, retain = false) {
  const client = await page.createCDPSession(), paints: number[] = [], pendingAcks = new Set<Promise<unknown>>();
  let decoding = Promise.resolve(), decodeError: unknown, armed = false, firstBad: Buffer | undefined;
  let ready!: () => void;
  const baseline = new Promise<void>(resolve => { ready = resolve; });
  await page.evaluate(() => {
    const marker = document.createElement('div'); marker.id = 'navigation-paint-witness';
    marker.style.cssText = 'position:fixed;left:4px;top:4px;width:8px;height:8px;background:rgb(211,47,193);z-index:2147483647;pointer-events:none';
    document.body.append(marker);
  });
  client.on('Page.screencastFrame', event => {
    const ack = client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    pendingAcks.add(ack); void ack.catch(error => { decodeError ??= error; }).finally(() => pendingAcks.delete(ack));
    decoding = decoding.then(async () => {
      const png = Buffer.from(event.data, 'base64');
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const scale = info.width / page.viewport()!.width, witness = (Math.round(8 * scale) * info.width + Math.round(8 * scale)) * 3;
      if (!armed) {
        if (data[witness] !== 211 || data[witness + 1] !== 47 || data[witness + 2] !== 193) return;
        armed = true; ready();
      }
      // This fixture is uniformly plain text. A viewport with only its caret
      // line mounted loses its surrounding text, even though the caret exists.
      let ink = 0;
      for (let y = Math.round(info.height * .15); y < info.height * .8; y++) for (let x = Math.round(info.width * .08); x < info.width * .5; x++) {
        const at = (y * info.width + x) * 3;
        if (data[at] + data[at + 1] + data[at + 2] > 400) ink++;
      }
      paints.push(ink); if (ink < 1000) firstBad ??= png;
    }).catch(error => { decodeError ??= error; ready(); });
  });
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([baseline, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error(label + ': missing compositor baseline')), 5000);
  })]).finally(() => clearTimeout(deadline));
  await page.evaluate(() => {
    const scope = window as any, view = scope.__navigationView;
    scope.__navigationFrames = [];
    const sample = () => {
      const lines = [...view.contentDOM.querySelectorAll('.cm-line')] as HTMLElement[];
      const target = lines.find(line => line.textContent?.startsWith('Line 200'));
      const rect = target?.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
      scope.__navigationFrames.push({ scroll: view.scrollDOM.scrollTop, height: view.scrollDOM.scrollHeight,
        head: view.state.selection.main.head, top: rect?.top ?? null, bottom: rect?.bottom ?? null,
        viewportTop: bounds.top, viewportBottom: bounds.bottom,
        visibleContent: lines.some(line => { const box = line.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom; }) });
      scope.__navigationFrame = requestAnimationFrame(sample);
    }; sample();
  });
  try {
    await action();
    if (process.argv.includes('--negative-paint') && cases === 0) {
      const style = await page.addStyleTag({ content: '.editor-host .cm-line{visibility:hidden!important}' });
      await frames(page, 4); await style.evaluate(node => node.remove());
    }
    await frames(page, 55);
    await client.send('Page.stopScreencast'); await decoding; await Promise.allSettled(pendingAcks);
    const samples = await page.evaluate(() => (window as any).__navigationFrames) as Sample[];
    const positions: number[] = [];
    for (const sample of samples) if (!positions.length || Math.abs(sample.scroll - positions.at(-1)!) > 1) positions.push(sample.scroll);
    try {
      assert.ok(samples.length > 40, label + ': continuous observation');
      assert.equal(decodeError, undefined, label + ': paint decoder');
      assert.ok(paints.length >= 2, label + ': missing compositor observation');
      assert.ok(paints.every(ink => ink >= 1000), label + ': a painted viewport lost its surrounding text: ' + JSON.stringify(paints));
      assert.ok(positions.length <= (retain ? 1 : 2), label + ': preliminary reveal followed by another placement: ' + JSON.stringify(positions));
      const last = samples.at(-1)!;
      assert.ok(last.top !== null && last.bottom !== null && last.top >= last.viewportTop - 1 && last.bottom <= last.viewportBottom + 1,
        label + ': destination must be mounted and visible');
      const lineHeight = last.bottom! - last.top!, gapAbove = last.top! - last.viewportTop, gapBelow = last.viewportBottom - last.bottom!;
      if (label.endsWith('-undo-down')) assert.ok(gapBelow >= lineHeight * 2 - 2, label + ': retain history context below');
      if (label.endsWith('-redo-up')) assert.ok(gapAbove >= lineHeight * 2 - 2, label + ': retain history context above');
      if (label.includes('-search-')) assert.ok(Math.abs((last.top! + last.bottom! - last.viewportTop - last.viewportBottom) / 2) <= 5, label + ': retain search centering');
      if (label.includes('-line-jump-')) assert.ok(Math.abs(gapAbove - (last.viewportBottom - last.viewportTop) * .3) <= lineHeight, label + ': retain upper line-jump placement');
      if (label.endsWith('-native-scroll')) assert.ok(gapBelow <= lineHeight + 2, label + ': retain ordinary nearest-edge placement');
      if (retain) assert.ok(samples[0].bottom !== null && samples[0].viewportBottom - samples[0].bottom <= lineHeight,
        label + ': establish a visible target at the edge before replay');
    } catch (error) {
      fs.mkdirSync('.local/navigation-reveal-failures', { recursive: true });
      fs.writeFileSync(`.local/navigation-reveal-failures/${label.replace(/[^a-z0-9-]/gi, '-')}.json`, JSON.stringify(samples, null, 2));
      if (firstBad) fs.writeFileSync(`.local/navigation-reveal-failures/${label.replace(/[^a-z0-9-]/gi, '-')}.png`, firstBad);
      throw error;
    }
    paintedFrames += paints.length; cases++;
  } finally {
    await decoding; await Promise.allSettled(pendingAcks); await client.detach();
    await page.evaluate(() => { cancelAnimationFrame((window as any).__navigationFrame); delete (window as any).__navigationFrames; document.getElementById('navigation-paint-witness')?.remove(); });
  }
}

try {
  for (const mode of ['live', 'source'] as const) for (const large of [true, false]) {
    const text = Array.from({ length: large ? 8100 : 300 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} unchanged plain text.`).join('\n');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    const page = await browser.newPage(), host = await open(page, text, false, mode);
    try {
      const position = await page.evaluate(() => {
        const scope = window as any, view = scope.__navigationView = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const at = view.state.doc.line(200).to;
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true }); view.focus(); return at;
      });
      await frames(page, 8); await page.keyboard.type('Z'); await frames(page, 10);
      await shortcut(page, 'Home'); await frames(page, 8);
      const id = `${mode}-large-${large}`;
      await observeReveal(page, id + '-undo-down', () => shortcut(page, 'z'));
      assert.equal(host.readHost(), text);
      await shortcut(page, 'End'); await frames(page, 8);
      await observeReveal(page, id + '-redo-up', () => shortcut(page, 'y'));
      assert.equal(host.readHost(), text.slice(0, position) + 'Z' + text.slice(position));
      // A visible target near an edge retains its viewport; it must not gain a
      // comfort margin merely because this is a history command.
      const wheel = await page.evaluate(() => {
        const view = (window as any).__navigationView, caret = view.coordsAtPos(view.state.selection.main.head), bounds = view.scrollDOM.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, delta: caret.bottom - (bounds.bottom - 8) };
      });
      await page.mouse.move(wheel.x, wheel.y); await page.mouse.wheel({ deltaY: wheel.delta }); await frames(page, 12);
      await observeReveal(page, id + '-undo-visible-edge', () => shortcut(page, 'z'), true);
      assert.equal(host.readHost(), text);
      // A newer ordinary request must still retain native caret scrolling.
      await shortcut(page, 'Home'); await frames(page, 8);
      await observeReveal(page, id + '-native-scroll', async () => {
        await page.evaluate(() => {
          const view = (window as any).__navigationView;
          view.dispatch({ selection: { anchor: view.state.doc.line(200).from }, scrollIntoView: true });
        });
      });
      await shortcut(page, 'f'); await page.waitForSelector('.find-input', { visible: true });
      await page.type('.find-input', 'Line 200'); await frames(page, 12);
      for (const fromEnd of [false, true]) {
        await page.evaluate(fromEnd => {
          const view = (window as any).__navigationView;
          view.focus(); view.dispatch({ selection: { anchor: fromEnd ? view.state.doc.length : 0 }, scrollIntoView: true });
        }, fromEnd);
        await frames(page, 8); await page.focus('.find-input');
        await observeReveal(page, id + '-search-' + fromEnd, () => page.keyboard.press('Enter'));
      }
      await page.keyboard.press('Escape');
      for (const fromEnd of [false, true]) {
        await page.evaluate(fromEnd => {
          const view = (window as any).__navigationView;
          view.focus(); view.dispatch({ selection: { anchor: fromEnd ? view.state.doc.length : 0 }, scrollIntoView: true });
        }, fromEnd);
        await frames(page, 8); await page.focus('.line-jump-input'); await page.type('.line-jump-input', '200');
        await observeReveal(page, id + '-line-jump-' + fromEnd, () => page.keyboard.press('Enter'));
      }
      const inputEdge = await page.evaluate(() => {
        const view = (window as any).__navigationView;
        view.focus(); view.dispatch({ selection: { anchor: view.state.doc.line(200).to } });
        const caret = view.coordsAtPos(view.state.selection.main.head), bounds = view.scrollDOM.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, delta: caret.bottom - (bounds.bottom - 8) };
      });
      await page.mouse.move(inputEdge.x, inputEdge.y); await page.mouse.wheel({ deltaY: inputEdge.delta }); await frames(page, 12);
      await observeReveal(page, id + '-enter-edge', () => page.keyboard.press('Enter'));
      assert.equal(host.readHost(), text.slice(0, position) + '\n' + text.slice(position));
      assert.deepEqual(host.errors, [], id + ': runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  assert.equal(cases, 4 * 9, 'Every mode/scale pair must execute all nine navigation and input cases');
  console.log(`Navigation reveal passed: ${cases} cases, ${paintedFrames} compositor frames; history/search/line-jump/input/visible-edge/native-owner across Live/Source and ordinary/optimized Worker paths`);
} catch (error) { failure = error; throw error; }
finally { server.stop(true); if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
