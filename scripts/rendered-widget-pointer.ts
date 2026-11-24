import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';

export async function checkHtmlReadingPointer(page: Page): Promise<void> {
  const frames = (count = 4) => page.evaluate(async count => {
    for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
  }, count);
  const tail = '\n\nFiller paragraph for the optimized reading path.'.repeat(7000);
  let cases = 0;
  for (const large of [false, true]) for (const kind of ['block', 'inline', 'block-link', 'inline-link'] as const) {
    const inline = kind.startsWith('inline');
    const opening = kind.endsWith('link') ? '<a href="#after">' : '<span>';
    const closing = kind.endsWith('link') ? '</a>' : '</span>';
    const content = `${opening}ALPHA BETA GAMMA DELTA${closing}`;
    for (const action of ['drag', 'control-drag', 'return-drag', 'click', 'cancel', 'enter'] as const) {
      const fragment = inline ? `Inline ${content} tail.` : `<div><p>${content}</p></div>`;
      const text = `Before.\n\n${fragment}\n\nAfter.${large ? tail : ''}`;
      const label = `${kind}/${large ? 'optimized' : 'ordinary'}/${action}`;
      await page.evaluate(text => {
        const host = window as any;
        host.__htmlEditor?.destroy();
        document.getElementById('app')!.replaceChildren();
        host.__htmlEditor = host.HtmlContentHarness.createEditor({ parent: document.getElementById('app'),
          text, initialMode: 'live', initialCursorPos: 0, onApplyChanges() {} });
        document.getElementById('reading-control')?.remove();
        const control = document.createElement('button');
        control.id = 'reading-control';
        control.textContent = 'Control';
        control.style.cssText = 'position:fixed;right:0;bottom:0';
        document.body.append(control);
      }, text);
      await frames(16);
      await page.evaluate(action => {
        const view = (window as any).__htmlEditor.view;
        view.dispatch({ selection: { anchor: 0 } });
        if (action === 'control-drag') document.getElementById('reading-control')!.focus();
        else view.focus();
      }, action);
      await frames();
      const points = await page.evaluate(({ inline, large }) => {
        const host = window as any;
        const view = host.__htmlEditor.view;
        if (host.HtmlContentHarness.usesLargeDocumentDerivedWorkBudget(view.state) !== large)
          throw new Error('Reading fixture must enter the actual production work policy');
        const root = document.querySelector(inline ? '.meo-md-html-inline' : '.meo-md-html-block')!;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Text | null = null;
        while (walker.nextNode()) if (walker.currentNode.textContent === 'ALPHA BETA GAMMA DELTA') {
          node = walker.currentNode as Text;
          break;
        }
        if (!node) throw new Error('Missing rendered reading text');
        const point = (offset: number) => {
          const range = document.createRange();
          range.setStart(node!, offset); range.setEnd(node!, offset + 1);
          const bounds = range.getBoundingClientRect();
          return { x: Math.ceil(bounds.left + 1), y: Math.round((bounds.top + bounds.bottom) / 2) };
        };
        host.readingPointerTarget = root;
        root.addEventListener('pointerdown', event => { host.readingPointerId = (event as PointerEvent).pointerId; }, { once: true });
        return [point(0), point(5), point(10), point(16)];
      }, { inline, large });
      const read = () => page.evaluate(({ inline, opening }) => {
        const host = window as any;
        return { connected: host.readingPointerTarget.isConnected,
          native: window.getSelection()?.toString() ?? '',
          text: host.__htmlEditor.getText(),
          head: host.__htmlEditor.view.state.selection.main.head,
          focus: document.activeElement?.className,
          source: inline ? Array.from(host.__htmlEditor.view.contentDOM.querySelectorAll('.cm-line'))
            .some((line: any) => line.textContent.includes(opening)) : !!document.querySelector('.meo-md-html-live-result') };
      }, { inline, opening });
      await page.mouse.move(points[0]!.x, points[0]!.y);
      await page.mouse.down();
      await frames();
      assert.equal((await read()).source, false, label + ': press preserves reading content');
      if (action.includes('drag') || action === 'enter') {
        for (const point of points.slice(1)) {
          await page.mouse.move(point.x, point.y, { steps: 3 });
          await frames(2);
          const selected = await read();
          assert.ok(selected.native.length > 0, label + ': selection grows before release');
          // A harmless presentation transaction previously restored the suspended
          // CodeMirror caret and erased a native HTML selection mid-gesture.
          await page.evaluate(() => (window as any).__htmlEditor.view.dispatch({}));
          await frames(2);
          assert.equal((await read()).native, selected.native, label + ': refresh retains the growing range');
          assert.ok((await read()).connected, label + ': refresh retains the rendered text');
        }
        if (action === 'return-drag') await page.mouse.move(points[0]!.x, points[0]!.y, { steps: 8 });
      }
      if (action === 'cancel') await page.evaluate(() => {
        (window as any).readingPointerTarget.dispatchEvent(new PointerEvent('pointercancel',
          { bubbles: true, pointerId: (window as any).readingPointerId, button: 0 }));
      });
      await page.mouse.up();
      await frames(12);
      const released = await read();
      assert.equal(released.text, text, label + ': reading never edits the document');
      assert.equal(released.source, action === 'click', label + ': only a completed click enters source '
        + JSON.stringify({ head: released.head, focus: released.focus, connected: released.connected, native: released.native }));
      if (action === 'enter') {
        await page.keyboard.press('Enter'); await frames(12);
        assert.ok((await read()).source, label + ': Enter hands reading focus to source editing');
      }
      if (action === 'drag' || action === 'control-drag') {
        assert.ok(released.native.startsWith('ALPHA BETA'), label + ': release retains selected reading text');
        await page.keyboard.type('Q');
        assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text,
          label + ': reading text is read-only');
        assert.ok(await page.evaluate(() => (window as any).readingPointerTarget.textContent.includes('ALPHA BETA GAMMA DELTA')),
          label + ': native input cannot mutate rendered content');
        if (action === 'drag') {
          const client = await page.createCDPSession();
          try {
            await client.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
            await frames();
            assert.ok(await page.evaluate(() => (window as any).readingPointerTarget.textContent.includes('ALPHA BETA GAMMA DELTA')),
              label + ': noncancelable composition cannot mutate reading text');
            assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text,
              label + ': reading composition preserves Markdown');
            await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
          } finally { await client.detach(); }
          await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down();
          await page.mouse.move(points[3]!.x, points[3]!.y, { steps: 8 }); await page.mouse.up();
          await frames();
          assert.equal((await read()).native, released.native, label + ': a new reading drag works after composition');
        }
        await page.keyboard.down('Control'); await page.keyboard.press('KeyC'); await page.keyboard.up('Control');
        await page.evaluate(async () => {
          const editor = (window as any).__htmlEditor;
          await editor.setMode('source');
          editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
          editor.view.focus();
        });
        await frames();
        await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
        await frames();
        assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text + released.native,
          label + ': native copy pastes the rendered text');
        await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
        await frames();
        assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text,
          label + ': one undo restores the document');
      }
      cases++;
    }
  }
  await page.evaluate(() => document.getElementById('reading-control')?.remove());
  console.log(`HTML reading pointer passed: ${cases} ordinary/optimized block/inline gestures, refresh, native copy and history`);
}

export async function checkAtomicWidgetPointer(page: Page): Promise<void> {
  const frames = (count = 4) => page.evaluate(async count => {
    for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
  }, count);
  const fixtures = [
    { name: 'dollar', block: '$$\nx^2 + y^2 = 1\n$$', selector: '.meo-md-math-fenced-display .katex-html' },
    { name: 'fenced', block: '```tex\nx^2 + y^2 = 1\n```', selector: '.meo-md-math-fenced-display .katex-html' },
    { name: 'quoted', block: '> $$\n> x^2 + y^2 = 1\n> $$', selector: '.meo-md-math-fenced-display .katex-html' },
    { name: 'inline', block: 'Inline $x^2 + y^2 = 1$ tail.', selector: '.meo-md-math-inline' },
    { name: 'properties', block: '---\naliases: [ALPHA, BETA, GAMMA]\n---', selector: '.meo-md-frontmatter-array-pills' }
  ];
  let cases = 0;
  for (const large of [false, true]) for (const fixture of fixtures) {
    for (const action of ['click', 'drag', 'return-drag', 'cancel'] as const) {
      const text = `${fixture.name === 'properties' ? '' : 'Before.\n\n'}${fixture.block}\n\nAfter.`
        + (large ? '\n\nFiller paragraph for the optimized widget path.'.repeat(7000) : '');
      const label = `${fixture.name}/${large ? 'optimized' : 'ordinary'}/${action}`;
      await page.evaluate(({ text, properties }) => {
        const host = window as any;
        host.__htmlEditor?.destroy();
        document.getElementById('app')!.replaceChildren();
        host.__htmlEditor = host.HtmlContentHarness.createEditor({ parent: document.getElementById('app'), text,
          initialMode: 'live', initialCursorPos: properties ? text.indexOf('After.') : 0, onApplyChanges() {} });
        host.__htmlEditor.view.focus();
      }, { text, properties: fixture.name === 'properties' });
      await frames(16);
      await page.waitForSelector(fixture.selector);
      const point = await page.evaluate(({ selector, large }) => {
        const host = window as any;
        if (host.HtmlContentHarness.usesLargeDocumentDerivedWorkBudget(host.__htmlEditor.view.state) !== large)
          throw new Error('Atomic fixture must enter the production work policy');
        const node = document.querySelector(selector)!;
        host.atomicPointerTarget = node;
        node.addEventListener('pointerdown', event => { host.atomicPointerId = (event as PointerEvent).pointerId; }, { once: true });
        const range = document.createRange(); range.selectNodeContents(node);
        const bounds = range.getBoundingClientRect();
        return { x: Math.ceil(bounds.left + 3), y: Math.round((bounds.top + bounds.bottom) / 2),
          end: Math.min(Math.floor(bounds.right - 3), Math.ceil(bounds.left + 45)) };
      }, { selector: fixture.selector, large });
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await frames();
      assert.ok(await page.evaluate(() => (window as any).atomicPointerTarget.isConnected), label + ': press retains the rendered widget');
      if (action.includes('drag')) {
        await page.mouse.move(point.end, point.y, { steps: 6 });
        if (action === 'return-drag') await page.mouse.move(point.x, point.y, { steps: 6 });
      }
      if (action === 'cancel') await page.evaluate(() => {
        (window as any).atomicPointerTarget.dispatchEvent(new PointerEvent('pointercancel',
          { bubbles: true, pointerId: (window as any).atomicPointerId, button: 0 }));
      });
      await page.mouse.up(); await frames(12);
      assert.equal(await page.evaluate(() => (window as any).atomicPointerTarget.isConnected), action !== 'click',
        label + ': only a completed click reveals source');
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, label + ': gesture preserves source text');
      cases++;
    }
  }
  console.log(`Atomic widget pointer passed: ${cases} ordinary/optimized formula and property gestures`);
}
