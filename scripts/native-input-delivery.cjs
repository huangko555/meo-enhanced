// Test driver only. A successful CDP command is not an input-delivery receipt.
const assert = require('node:assert/strict');

class NativeInputCapabilityError extends Error {
  constructor(stage, evidence, cause) {
    super(`Native input capability failed at ${stage}`, { cause });
    this.name = 'NativeInputCapabilityError';
    this.code = 'native-input-unavailable';
    this.stage = stage;
    this.evidence = evidence;
  }
}

async function findActiveWebview(browser, heading) {
  const matches = [];
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    const accepted = await frame.evaluate(heading => {
      const root = document.querySelector('.editor-root');
      return window.frameElement?.id === 'active-frame' && root?.textContent?.includes(heading)
        && getComputedStyle(window.frameElement).visibility === 'visible'
        && !document.querySelector('.meo-preload-toolbar');
    }, heading).catch(() => false);
    if (accepted) matches.push({ page, frame });
  }
  assert.equal(matches.length, 1, 'Exactly one active Webview must match the disposable document heading');
  return matches[0];
}

async function createPointerDriver({ frame, page, mouse = page.mouse, timeoutMs = 2000 }) {
  let owner = frame;
  let id;
  while (owner && !id) {
    try { id = new URL(owner.url()).searchParams.get('id'); } catch { /* Not the Webview owner. */ }
    owner = owner.parentFrame();
  }
  assert.ok(id, 'A Webview owner id is required');

  const pointFor = async selector => {
    const point = await frame.$eval(selector, node => {
      if (window.frameElement?.id !== 'active-frame') throw Error('The content frame is not active');
      if (!node.isConnected || node.closest('[inert]') || node.disabled) throw Error('Target is not interactive');
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (style.visibility !== 'visible' || right <= left || bottom <= top) throw Error('Target is not visible');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      if (!node.contains(document.elementFromPoint(x, y))) throw Error('The target is covered');
      const contentFrame = window.frameElement.getBoundingClientRect();
      return { x, y, innerX: contentFrame.x, innerY: contentFrame.y };
    });
    const origin = await page.evaluate(({ id, point }) => {
      const owners = [...document.querySelectorAll('iframe')].filter(node => {
        try { return new URL(node.src).searchParams.get('id') === id; } catch { return false; }
      });
      if (owners.length !== 1) throw Error('The outer Webview is not unique');
      const owner = owners[0], rect = owner.getBoundingClientRect();
      const x = rect.x + point.innerX + point.x, y = rect.y + point.innerY + point.y;
      if (getComputedStyle(owner).visibility !== 'visible' || document.elementFromPoint(x, y) !== owner) {
        throw Error('The outer Webview is hidden or covered');
      }
      return { x, y, owner: id };
    }, { id, point });
    return { local: point, root: origin };
  };

  const gesture = async (selector, delta = { x: 0, y: 0 }) => {
    const evidence = { selector, delta, commands: [], events: [], releaseAttempted: false };
    let stage = 'target', armed = false, held = false;
    try {
      const point = await pointFor(selector);
      evidence.point = point;
      await frame.evaluate(selector => {
        if (window.__meoInputDelivery) throw Error('Another pointer probe is active');
        const events = [];
        const expectedTarget = document.querySelector(selector);
        const record = event => {
          events.push({ type: event.type, trusted: event.isTrusted, pointerId: event.pointerId,
            button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY,
            target: event.target?.tagName, className: String(event.target?.className ?? ''),
            targetMatches: Boolean(expectedTarget?.isConnected && expectedTarget.contains(event.target)) });
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.addEventListener(type, record, true);
        window.__meoInputDelivery = { events, stop() {
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.removeEventListener(type, record, true);
        } };
      }, selector);
      armed = true;
      await mouse.move(point.root.x, point.root.y);
      evidence.commands.push('move');
      stage = 'pointerdown';
      held = true;
      await mouse.down();
      evidence.commands.push('press acknowledged');
      await frame.waitForFunction(({ x, y }) => window.__meoInputDelivery.events.some(event =>
        event.type === 'pointerdown' && event.trusted && event.button === 0 && event.targetMatches
        && Math.abs(event.x - x) <= 1 && Math.abs(event.y - y) <= 1),
      { timeout: timeoutMs }, point.local);
      if (delta.x || delta.y) {
        stage = 'pointermove';
        await mouse.move(point.root.x + delta.x, point.root.y + delta.y, { steps: 6 });
        evidence.commands.push('drag acknowledged');
      }
      stage = 'pointerup';
      evidence.releaseAttempted = true;
      await mouse.up();
      held = false;
      evidence.commands.push('release acknowledged');
      await frame.waitForFunction(() => {
        const events = window.__meoInputDelivery.events;
        const down = events.find(event => event.type === 'pointerdown' && event.trusted);
        return events.some(event => event.type === 'pointerup' && event.trusted && event.pointerId === down.pointerId);
      }, { timeout: timeoutMs });
      return evidence;
    } catch (cause) {
      throw new NativeInputCapabilityError(stage, evidence, cause);
    } finally {
      if (held) {
        evidence.releaseAttempted = true;
        try { await mouse.up(); } catch (error) { evidence.releaseError = String(error); }
      }
      if (armed) {
        try {
          evidence.events = await frame.evaluate(() => {
            const probe = window.__meoInputDelivery;
            probe.stop(); delete window.__meoInputDelivery;
            return probe.events;
          });
        } catch (error) { evidence.observationError = String(error); }
      }
    }
  };
  return { click: selector => gesture(selector), drag: (selector, x, y = 0) => gesture(selector, { x, y }) };
}

module.exports = { NativeInputCapabilityError, findActiveWebview, createPointerDriver };
