import assert from 'node:assert/strict';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';

async function exerciseClickScrollHandoff(count: number, wrapped = false, scale = 1) {
  const page = await browser.newPage();
  const text = '# Click scroll handoff\n\n' + Array.from({ length: count }, (_, i) =>
    `## Heading ${i}\n\nShort paragraph ${i}. ${wrapped ? 'Wrapped text. '.repeat(8) : ''}\n\n`).join('');
  const host = await open(page, text);
  try {
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: scale });
    await page.click('.source-preview-button');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.inert
      && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'));
    await page.evaluate(() => {
      const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      v.scrollDOM.scrollTop = v.lineBlockAt(v.state.doc.line(251).from).top;
    });
    await frames(page, 12);
    const target = await page.evaluate(() => {
      const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      const bounds = v.scrollDOM.getBoundingClientRect();
      const element = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')]
        .filter(e => e.textContent?.startsWith('Short paragraph'))
        .filter(e => { const r = e.getBoundingClientRect(); return r.top > bounds.top && r.bottom < bounds.bottom - 5; }).at(-1)!;
      const r = element.getBoundingClientRect(), x = r.left + 24, y = r.top + r.height / 2;
      return { x, y, line: v.state.doc.lineAt(v.posAtCoords({ x, y })).number, text: element.textContent };
    });
    await page.waitForFunction(line => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector(`p[data-source-line="${line}"]`), {}, target.line);
    if (wrapped) {
      // Wrapped Source/Preview lines can have similar density. Establish the
      // same legitimate offset as a previous minimal reveal before clicking.
      await page.evaluate(line => {
        const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const r = d.querySelector<HTMLElement>(`p[data-source-line="${line}"]`)!.getBoundingClientRect();
        d.scrollingElement!.scrollTop -= Math.max(0, d.documentElement.clientHeight + 80 - r.top);
      }, target.line);
      await frames(page, 8);
    }
    const before = await page.evaluate(line => {
      const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const r = d.querySelector<HTMLElement>(`p[data-source-line="${line}"]`)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: d.documentElement.clientHeight };
    }, target.line);
    assert.ok(before.top >= before.height, `The Source bottom click must need a real Preview reveal: ${JSON.stringify(before)}`);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(line => {
      const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const r = d.querySelector<HTMLElement>(`p[data-source-line="${line}"]`)?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= d.documentElement.clientHeight;
    }, {}, target.line);
    await frames(page, 8);
    const initial = await page.evaluate(line => {
      const scope = window as any, d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      scope.__handoffLine = line;
      scope.__handoffSamples = []; scope.__handoffSampling = true;
      const read = () => {
        const e = d.querySelector<HTMLElement>(`p[data-source-line="${scope.__handoffLine}"]`), r = e?.getBoundingClientRect();
        return { source: document.querySelector('.editor-host .cm-scroller')!.scrollTop,
          preview: d.scrollingElement!.scrollTop, y: r?.top ?? null, visible: !!r && r.bottom > 0 && r.top < d.documentElement.clientHeight };
      };
      const sample = () => { if (!scope.__handoffSampling) return; scope.__handoffSamples.push(read()); requestAnimationFrame(sample); };
      scope.__handoffRead = read;
      scope.__handoffStart = () => { scope.__handoffSamples = []; scope.__handoffSampling = true; requestAnimationFrame(sample); return read(); };
      requestAnimationFrame(sample); return read();
    }, target.line);
    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel({ deltaY: 48 });
    await new Promise(resolve => setTimeout(resolve, 500)); await frames(page, 8);
    const samples = await page.evaluate(() => { (window as any).__handoffSampling = false;
      return (window as any).__handoffSamples as Array<{ source: number; preview: number; y: number | null; visible: boolean }>; });
    assert.ok(samples.at(-1)!.source > initial.source + 20, 'The native Source wheel must actually move');
    const pullback = Math.max(...samples.map(s => initial.preview - s.preview));
    assert.ok(pullback <= 1 && samples.every(s => s.visible),
      `Click reveal must hand off to scrolling without pulling the newly visible paragraph away: ${JSON.stringify({ count, target, initial, pullback, last: samples.at(-1) })}`);
    for (const [owner, delta] of [['source', -48], ['preview', 48], ['preview', -48], ['source', 48], ['source', -48]] as const) {
      const point = owner === 'source' ? target : await page.$eval('.preview-frame', el => {
        const r = el.getBoundingClientRect(); return { x: r.right - 12, y: r.top + r.height / 2 };
      });
      const baseline = await page.evaluate(() => (window as any).__handoffStart());
      await page.mouse.move(point.x, point.y); await page.mouse.wheel({ deltaY: delta });
      await new Promise(resolve => setTimeout(resolve, 400)); await frames(page, 8);
      const next = await page.evaluate(() => { (window as any).__handoffSampling = false;
        return (window as any).__handoffSamples as Array<{ source: number; preview: number; y: number | null; visible: boolean }>; });
      const driver = owner === 'source' ? 'source' : 'preview', follower = owner === 'source' ? 'preview' : 'source';
      const sign = Math.sign(delta);
      assert.ok(sign * (next.at(-1)![driver] - baseline[driver]) > 20, 'Every wheel must move its actual native driver');
      assert.ok(next.every(s => sign * (s[follower] - baseline[follower]) >= -1 && s.visible),
        `A ${owner} ${delta} wheel must continue from the current pair without an opposite jump: ${JSON.stringify({ count, baseline, last: next.at(-1) })}`);
    }
    const returned = await page.evaluate(() => (window as any).__handoffRead());
    assert.ok(Math.abs(returned.source - initial.source) <= 2 && Math.abs(returned.y - initial.y!) <= 2,
      `Alternating owners and directions must not accumulate reading drift: ${JSON.stringify({ count, initial, returned })}`);
    const upper = await page.evaluate(() => {
      const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      const bounds = v.scrollDOM.getBoundingClientRect();
      const e = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')]
        .filter(e => e.textContent?.startsWith('Short paragraph')).find(e => e.getBoundingClientRect().top > bounds.top + 5)!;
      const r = e.getBoundingClientRect(), x = r.left + 24, y = r.top + 10;
      const line = v.state.doc.lineAt(v.posAtCoords({ x, y })).number;
      const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const p = d.querySelector<HTMLElement>(`p[data-source-line="${line}"]`);
      return { x, y, line, hidden: !p || p.getBoundingClientRect().bottom <= 0 };
    });
    if (count > 180) {
      if (!wrapped) assert.ok(upper.hidden, 'The second Source click must reveal content above the current Preview');
      await page.mouse.click(upper.x, upper.y);
      await page.waitForFunction(line => {
        const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const r = d.querySelector<HTMLElement>(`p[data-source-line="${line}"]`)?.getBoundingClientRect();
        return r && r.bottom > 0 && r.top < d.documentElement.clientHeight;
      }, {}, upper.line);
      await frames(page, 8);
      await page.evaluate(line => { (window as any).__handoffLine = line; }, upper.line);
      const newOrigin = await page.evaluate(() => (window as any).__handoffRead());
      for (const delta of [-48, 48]) {
        const baseline = await page.evaluate(() => (window as any).__handoffStart());
        await page.mouse.move(upper.x, upper.y); await page.mouse.wheel({ deltaY: delta });
        await new Promise(resolve => setTimeout(resolve, 400)); await frames(page, 8);
        const next = await page.evaluate(() => { (window as any).__handoffSampling = false; return (window as any).__handoffSamples; });
        assert.ok(next.every((s: any) => Math.sign(delta) * (s.preview - baseline.preview) >= -1 && s.visible),
          'A new Source click must replace the previous scroll origin without a reverse jump');
      }
      const restored = await page.evaluate(() => (window as any).__handoffRead());
      assert.ok(Math.abs(restored.source - newOrigin.source) <= 2 && Math.abs(restored.y - newOrigin.y) <= 2,
        'A second click must not accumulate the first click\'s offset');
    }
    if (process.argv.includes('--capture')) await page.screenshot({ path: `.local/click-scroll-${count}-${wrapped}-${scale}.png` });
    assert.equal(host.readHost(), text, 'Scrolling must never edit source');
    assert.deepEqual(host.errors, []);
    console.log(`Click/scroll continuity passed (${count} sections, wrapped=${wrapped}, DPR=${scale})`);
  } finally { host.dispose(); await page.close(); }
}

async function exercise(count: number) {
  const page = await browser.newPage();
  const text = '# Edit ownership\n\n' + Array.from({ length: count }, (_, i) =>
    `## Section ${i}\n\nParagraph ${i} has **formatted** text and a [link](https://example.test). `
      + 'This source line wraps differently from the rendered paragraph. '.repeat(i % 5 + 1) + '\n\n'
  ).join('');
  const host = await open(page, text);
  try {
  await page.click('.source-preview-button');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.inert
    && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'));
  assert.equal(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!
    .documentElement.dataset.meoPreviewWindowed), String(count > 180), 'Cover both full-DOM and windowed Preview');
  await page.evaluate(() => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(250).from).top;
  });
  await frames(page, 12);
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
    ?.querySelector('[data-source-line="251"]'));
  const point = await page.evaluate(() => {
    const scroll = document.querySelector('.editor-host .cm-scroller')!.getBoundingClientRect();
    const lines = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')]
      .filter(line => line.textContent?.startsWith('Paragraph'))
      .map(line => line.getBoundingClientRect()).filter(rect => rect.top > scroll.top + 120 && rect.bottom < scroll.bottom - 5);
    const rect = lines.at(-1)!;
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const position = view.posAtCoords({ x: rect.left + 100, y: rect.bottom - 8 });
    const line = view.state.doc.lineAt(position).number;
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = doc.querySelector<HTMLElement>(`[data-source-line="${line}"]`)!;
    doc.scrollingElement!.scrollTop += target.getBoundingClientRect().top - 250;
    return { x: rect.left + 100, y: rect.bottom - 8 };
  });
  await page.mouse.click(point.x, point.y);
  await frames(page, 8);
  const before = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const top = doc.scrollingElement!.scrollTop;
    const elements = [...doc.querySelectorAll<HTMLElement>('h2')];
    const witness = elements.find(e => e.getBoundingClientRect().top >= 0)!;
    (window as any).__ownershipWitness = witness;
    (window as any).__ownershipSamples = [];
    (window as any).__ownershipSampling = true;
    const sample = () => {
      if (!(window as any).__ownershipSampling) return;
      (window as any).__ownershipSamples.push({ scroll: doc.scrollingElement!.scrollTop,
        y: witness.getBoundingClientRect().top, connected: witness.isConnected,
        source: document.querySelector('.editor-host .cm-scroller')!.scrollTop });
      requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
    return { top, y: witness.getBoundingClientRect().top };
  });
  await page.keyboard.type('1234567890'.repeat(12));
  for (let i = 0; i < 30; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('continued typing');
  await new Promise(resolve => setTimeout(resolve, 1000));
  await frames(page, 12);
  const samples = await page.evaluate(() => {
    (window as any).__ownershipSampling = false;
    return (window as any).__ownershipSamples as Array<{ scroll: number; y: number; connected: boolean; source: number }>;
  });
  assert.ok(samples.length > 10);
  const movement = Math.max(...samples.map(s => Math.abs(s.y - before.y)));
  assert.ok(samples.every(s => s.connected), 'The unchanged reading witness must retain its DOM identity');
  assert.ok(Math.max(...samples.map(s => s.source)) - Math.min(...samples.map(s => s.source)) > 100,
    'The regression must actually trigger Source caret auto-scrolling');
  assert.ok(movement <= 1, `Editing inside the visible Preview must not navigate it, including idle publication: ${JSON.stringify({ before, movement, last: samples.at(-1), sourceRange: [Math.min(...samples.map(s => s.source)), Math.max(...samples.map(s => s.source))] })}`);
  await page.evaluate(() => {
    const scope = window as any, original = scope.__presentationHost;
    scope.__ownershipGate = true;
    scope.__presentationHost = async (message: any) => {
      const result = await original(message);
      if (message.type === 'requestPreviewRender' && scope.__ownershipGate) {
        scope.__ownershipPending = true;
        await new Promise(resolve => { scope.__ownershipRelease = resolve; });
      }
      return result;
    };
  });
  await page.keyboard.type('x');
  await page.waitForFunction(() => (window as any).__ownershipPending);
  const heldTop = await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop);
  const scrollPoint = await page.$eval('.editor-host .cm-scroller', el => {
    const rect = el.getBoundingClientRect(); return { x: rect.left + 100, y: rect.top + 100 };
  });
  await page.mouse.move(scrollPoint.x, scrollPoint.y);
  await page.mouse.wheel({ deltaY: 340 });
  await frames(page, 12);
  const pendingTop = await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop);
  assert.ok(Math.abs(pendingTop - heldTop) <= 1, `A real Source scroll must wait for matching Preview source coordinates: ${JSON.stringify({ heldTop, pendingTop })}`);
  await page.evaluate(() => { (window as any).__ownershipGate = false; (window as any).__ownershipRelease(); });
  await new Promise(resolve => setTimeout(resolve, 650));
  const acceptedTop = await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop);
  assert.ok(Math.abs(acceptedTop - heldTop) > 2, 'The latest deliberate Source scroll must follow once the matching Preview is ready');

  // A click made against a still-pending revision must reveal once the matching
  // source-backed block is mounted, and must not use the old line-number map.
  await page.evaluate(() => { (window as any).__ownershipGate = true; (window as any).__ownershipPending = false; });
  await page.keyboard.type('y');
  await page.waitForFunction(() => (window as any).__ownershipPending);
  const clickTarget = await page.evaluate(() => {
    const scroll = document.querySelector('.editor-host .cm-scroller')!.getBoundingClientRect();
    const line = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')]
      .find(e => e.textContent?.startsWith('Paragraph') && e.getBoundingClientRect().top > scroll.top + 30
        && e.getBoundingClientRect().bottom < scroll.bottom)!;
    const r = line.getBoundingClientRect();
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    d.scrollingElement!.scrollTop = d.scrollingElement!.scrollHeight;
    return { x: r.left + 40, y: r.top + 10 };
  });
  await frames(page);
  const beforeClick = await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop);
  await page.mouse.click(clickTarget.x, clickTarget.y); await frames(page);
  assert.ok(Math.abs(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop) - beforeClick) <= 1,
    'A pending Source click must not locate unrelated old content');
  await page.evaluate(() => { (window as any).__ownershipGate = false; (window as any).__ownershipRelease(); });
  await page.waitForFunction(() => {
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = d.querySelector<HTMLElement>('.meo-preview-source-position-marker');
    const r = marker?.getBoundingClientRect();
    return marker && !marker.hidden && r!.bottom > 0 && r!.top < d.documentElement.clientHeight;
  });
  await frames(page, 12);
  const locatedTop = await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop);
  await page.mouse.click(clickTarget.x, clickTarget.y); await frames(page, 12);
  assert.ok(Math.abs(await page.$eval('.preview-frame', el => (el as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop) - locatedTop) <= 1,
    'Repeating a click in an already visible block must not navigate');
  if (process.argv.includes('--capture')) await page.screenshot({ path: `.local/source-preview-position-${count}.png` });

  await page.click('.source-preview-scroll-sync-button');
  const independentY = await page.evaluate(() => {
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const line = d.querySelector<HTMLElement>('.meo-preview-source-position-marker')!.dataset.meoSourcePositionLine;
    const witness = d.querySelector<HTMLElement>(`[data-source-line="${line}"]`)!;
    (window as any).__independentLine = line;
    return witness.getBoundingClientRect().top;
  });
  await page.mouse.click(clickTarget.x, clickTarget.y);
  await page.keyboard.type(' independent edit ');
  await page.mouse.move(scrollPoint.x, scrollPoint.y); await page.mouse.wheel({ deltaY: 360 });
  await new Promise(resolve => setTimeout(resolve, 650)); await frames(page, 12);
  const independentAfter = await page.evaluate(() => {
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const e = d.querySelector<HTMLElement>(`[data-source-line="${(window as any).__independentLine}"]`);
    return { connected: !!e?.isConnected, y: e?.getBoundingClientRect().top ?? NaN };
  });
  assert.ok(independentAfter.connected && Math.abs(independentAfter.y - independentY) <= 1,
    `Independent Source clicks, edits, scrolling and idle refresh must leave Preview in place: ${JSON.stringify({ independentY, independentAfter })}`);

  await page.click('.source-preview-scroll-sync-button');
  await new Promise(resolve => setTimeout(resolve, 350));
  const positions = () => page.evaluate(() => ({ source: document.querySelector('.editor-host .cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop }));
  await page.$eval('.editor-host .cm-content', el => (el as HTMLElement).focus({ preventScroll: true }));
  const sourcePageBefore = await positions();
  await page.keyboard.press('PageDown'); await new Promise(resolve => setTimeout(resolve, 350)); await frames(page, 12);
  const sourcePageAfter = await positions();
  assert.ok(sourcePageAfter.source - sourcePageBefore.source > 10 && sourcePageAfter.preview - sourcePageBefore.preview > 10,
    `Source PageDown must release its input hold and drive Preview: ${JSON.stringify({ sourcePageBefore, sourcePageAfter })}`);
  const previewPoint = await page.$eval('.preview-frame', el => { const r = el.getBoundingClientRect();
    return { x: r.right - 12, y: r.top + r.height / 2 }; });
  await page.mouse.click(previewPoint.x, previewPoint.y);
  const previewPageBefore = await positions();
  await page.keyboard.press('PageDown'); await new Promise(resolve => setTimeout(resolve, 350)); await frames(page, 12);
  const previewPageAfter = await positions();
  assert.ok(previewPageAfter.preview - previewPageBefore.preview > 10 && previewPageAfter.source - previewPageBefore.source > 10,
    `Preview PageDown must take ownership without a Source echo: ${JSON.stringify({ previewPageBefore, previewPageAfter })}`);

  await page.evaluate(() => { (window as any).__ownershipGate = true; (window as any).__ownershipPending = false; });
  await host.replaceHostText('<!-- upstream revision -->\n' + host.readHost());
  await page.waitForFunction(() => (window as any).__ownershipPending);
  const upstreamClick = await page.evaluate(() => {
    const bounds = document.querySelector('.editor-host .cm-scroller')!.getBoundingClientRect();
    const target = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')].find(e =>
      e.textContent?.startsWith('Paragraph') && e.getBoundingClientRect().top > bounds.top + 20
      && e.getBoundingClientRect().bottom < bounds.bottom)!;
    const r = target.getBoundingClientRect();
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    d.scrollingElement!.scrollTop = d.scrollingElement!.scrollHeight;
    return { x: r.left + 50, y: r.top + 10 };
  });
  await page.mouse.click(upstreamClick.x, upstreamClick.y);
  await page.evaluate(() => { (window as any).__ownershipGate = false; (window as any).__ownershipRelease(); });
  await page.waitForFunction(() => {
    const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = d.querySelector<HTMLElement>('.meo-preview-source-position-marker'), r = marker?.getBoundingClientRect();
    return marker && !marker.hidden && r!.bottom > 0 && r!.top < d.documentElement.clientHeight;
  });
  assert.equal(await page.$eval('.editor-host .cm-content', el => (el as any).cmTile.root.view.state.doc.toString()), host.readHost());
  assert.deepEqual(host.errors, []);
  console.log(`Source split Preview edit ownership passed (${count} sections)`);
  } catch (error) {
    console.log('ownership failure', count, await page.evaluate(() => {
      const d = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const marker = d.querySelector<HTMLElement>('.meo-preview-source-position-marker');
      const v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      return { marker: marker?.outerHTML, rect: marker?.getBoundingClientRect().toJSON(), top: d.scrollingElement!.scrollTop,
        selectedLine: v.state.doc.lineAt(v.state.selection.main.head).number, ready: d.body.textContent?.includes('continued typing'), errors: (window as any).__ownershipErrors };
    }));
    await page.screenshot({ path: `.local/source-preview-ownership-failure-${count}.png` });
    throw error;
  } finally { host.dispose(); await page.close(); }
}
let primaryError: unknown;
try {
  for (const [count, wrapped, scale] of [[180, false, 1], [5000, false, 1], [180, true, 1], [1800, true, 1.25]] as const) {
    await exerciseClickScrollHandoff(count, wrapped, scale);
  }
  if (!process.argv.includes('--handoff-only')) for (const count of process.argv.includes('--ordinary-only') ? [180] : [180, 2500]) await exercise(count);
}
catch (error) { primaryError = error; }
finally { server.stop(true); if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
