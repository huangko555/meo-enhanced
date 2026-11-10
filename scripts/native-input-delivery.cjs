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

async function inspectContentFrameOwner(frame) {
  const element = await frame.frameElement();
  if (!element) throw Error('The content frame has no parent iframe owner');
  try {
    return await element.evaluate(node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        id: node.id,
        visible: style.visibility === 'visible' && !node.hidden && rect.width > 0 && rect.height > 0,
        inert: Boolean(node.closest('[inert]')),
        x: rect.x,
        y: rect.y
      };
    });
  } finally {
    await element.dispose();
  }
}

async function findActiveWebview(browser, heading) {
  const matches = [];
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    const accepted = await (async () => {
      const hasActiveDocument = await frame.evaluate(heading => {
        const root = document.querySelector('.editor-root');
        return Boolean(root?.textContent?.includes(heading) && !document.querySelector('.meo-preload-toolbar'));
      }, heading);
      if (!hasActiveDocument) return false;
      const owner = await inspectContentFrameOwner(frame);
      return owner.id === 'active-frame' && owner.visible && !owner.inert;
    })().catch(() => false);
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
      if (!node.isConnected || node.closest('[inert]') || node.disabled) throw Error('Target is not interactive');
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (style.visibility !== 'visible' || right <= left || bottom <= top) throw Error('Target is not visible');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      if (!node.contains(document.elementFromPoint(x, y))) throw Error('The target is covered');
      return { x, y };
    });
    const contentFrame = await inspectContentFrameOwner(frame);
    if (contentFrame.id !== 'active-frame' || !contentFrame.visible || contentFrame.inert) {
      throw Error('The content frame is not active');
    }
    point.innerX = contentFrame.x;
    point.innerY = contentFrame.y;
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
    const binding = '__meoInputReceipt_' + Math.random().toString(36).slice(2);
    let stage = 'target', armed = false, held = false, bound = false, notify;
    // Receiving an input is independent of the render task it starts. Observe
    // through the protocol binding, so a busy renderer cannot starve polling.
    const waitForReceipt = predicate => {
      if (evidence.events.some(predicate)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { notify = undefined; reject(new Error(`Input receipt exceeded ${timeoutMs}ms`)); }, timeoutMs);
        notify = () => {
          if (!evidence.events.some(predicate)) return;
          clearTimeout(timer); notify = undefined; resolve();
        };
      });
    };
    try {
      let point = await pointFor(selector);
      evidence.point = point;
      await page.exposeFunction(binding, event => { evidence.events.push(event); notify?.(); });
      bound = true;
      await frame.evaluate(({ selector, binding }) => {
        if (window.__meoInputDelivery) throw Error('Another pointer probe is active');
        const events = [];
        const expectedTarget = document.querySelector(selector);
        const record = event => {
          const receipt = { type: event.type, trusted: event.isTrusted, pointerId: event.pointerId,
            button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY,
            target: event.target?.tagName, className: String(event.target?.className ?? ''),
            targetMatches: Boolean(expectedTarget?.isConnected && expectedTarget.contains(event.target)) };
          events.push(receipt);
          void window[binding](receipt).catch(() => {});
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.addEventListener(type, record, true);
        window.__meoInputDelivery = { events, stop() {
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.removeEventListener(type, record, true);
        } };
      }, { selector, binding });
      armed = true;
      await mouse.move(point.root.x, point.root.y);
      evidence.commands.push('move');
      stage = 'pointermove';
      await waitForReceipt(event => event.type === 'pointermove' && event.trusted);
      const isCurrentMove = event => event.type === 'pointermove' && event.trusted && event.targetMatches
        && Math.abs(event.x - point.local.x) <= 1 && Math.abs(event.y - point.local.y) <= 1;
      if (!evidence.events.some(isCurrentMove)) {
        const current = await pointFor(selector);
        if (Math.abs(current.root.x - point.root.x) <= 1 && Math.abs(current.root.y - point.root.y) <= 1) {
          throw new Error('Delivered movement did not reach the unchanged target');
        }
        evidence.geometryChange = { before: point, after: current };
        point = current; evidence.point = point;
        await mouse.move(point.root.x, point.root.y);
        evidence.commands.push('move after observed layout change');
        await waitForReceipt(isCurrentMove);
      }
      stage = 'pointerdown';
      held = true;
      await mouse.down();
      evidence.commands.push('press acknowledged');
      await waitForReceipt(event =>
        event.type === 'pointerdown' && event.trusted && event.button === 0 && event.targetMatches
        && Math.abs(event.x - point.local.x) <= 1 && Math.abs(event.y - point.local.y) <= 1);
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
      const down = evidence.events.find(event => event.type === 'pointerdown' && event.trusted);
      await waitForReceipt(event => event.type === 'pointerup' && event.trusted && event.pointerId === down.pointerId);
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
      if (bound) {
        try {
          await page.removeExposedFunction(binding);
          // Puppeteer's public removal leaves an undefined wrapper property.
          await Promise.all(page.frames().map(target => target.evaluate(name => { delete window[name]; }, binding)
            .catch(error => { if (!target.detached) throw error; })));
        }
        catch (error) { evidence.observationError = String(error); }
      }
    }
  };
  return { click: selector => gesture(selector), drag: (selector, x, y = 0) => gesture(selector, { x, y }) };
}

module.exports = { NativeInputCapabilityError, findActiveWebview, createPointerDriver };
