import assert from 'node:assert/strict';
import { createReadingPositionLifecycle } from '../webview/src/application/readingPositionLifecycle';

let nextTimer = 1;
const timers = new Map<number, () => void>();
const restored: Array<{ line: number; lineOffset: number }> = [];
const posted: Array<{ line: number; lineOffset: number }> = [];
let restoreReady = false;
let captured = { line: 1, lineOffset: 0 };

const lifecycle = createReadingPositionLifecycle({
  timer: {
    schedule(callback) {
      const handle = nextTimer;
      nextTimer += 1;
      timers.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      timers.delete(handle as number);
    }
  },
  capture: () => captured,
  restore: (position) => {
    if (!restoreReady) return false;
    restored.push(position);
    return true;
  },
  post: (position) => posted.push(position),
  debounceMs: 50
});

lifecycle.start({ enabled: true, restore: { line: 42, lineOffset: 5 } });
lifecycle.viewportChanged();
assert.equal(timers.size, 0, 'layout scrolls before restore must not overwrite the saved anchor');
assert.equal(lifecycle.surfaceReady(), false);
restoreReady = true;
assert.equal(lifecycle.surfaceReady(), true);
assert.deepEqual(restored, [{ line: 42, lineOffset: 5 }]);

lifecycle.viewportChanged();
lifecycle.viewportChanged();
assert.equal(timers.size, 1, 'scroll reporting must be trailing-edge debounced');
const pending = [...timers.values()][0];
timers.clear();
captured = { line: 55, lineOffset: 2.25 };
pending();
assert.deepEqual(posted, [{ line: 55, lineOffset: 2.25 }]);
lifecycle.viewportChanged();
[...timers.values()][0]();
timers.clear();
assert.equal(posted.length, 1, 'an unchanged anchor must not be posted twice');

lifecycle.start({ enabled: true, restore: { line: 90, lineOffset: 0 } });
lifecycle.userInteracted();
assert.equal(lifecycle.surfaceReady(), false, 'user interaction must cancel a pending restore');
lifecycle.start({ enabled: true, restore: { line: 91, lineOffset: 0 } });
lifecycle.explicitNavigation();
assert.equal(lifecycle.surfaceReady(), false, 'explicit navigation must cancel a pending restore');

captured = { line: 70, lineOffset: 1 };
lifecycle.flush();
assert.deepEqual(posted.at(-1), captured);
lifecycle.setEnabled(false);
captured = { line: 80, lineOffset: 0 };
lifecycle.viewportChanged();
lifecycle.flush();
assert.notDeepEqual(posted.at(-1), captured, 'disabled reporting must stay silent');
lifecycle.dispose();

console.log('Reading position lifecycle checks passed');
