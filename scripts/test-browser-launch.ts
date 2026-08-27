import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Browser } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import {
  closeTestBrowser,
  launchOwnedTestBrowser,
  type TestBrowserLaunchDependencies
} from './browser-test-helpers';

type FakeBrowser = {
  browser: Browser;
  process: EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
  closeCalls: number;
  setCloseAction(action: () => void): void;
  emitDisconnected(): void;
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
};

function createFakeBrowser(options: { closeFailure?: unknown } = {}): FakeBrowser {
  const browserEvents = new EventEmitter();
  const process = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
  let connected = true;
  let closeCalls = 0;
  let closeAction = () => {};
  const browser = browserEvents as unknown as Browser & {
    connected: boolean;
    process(): typeof process;
    close(): Promise<void>;
  };
  Object.defineProperty(browser, 'connected', { get: () => connected });
  browser.process = () => process;
  browser.close = async () => {
    closeCalls += 1;
    if (options.closeFailure) throw options.closeFailure;
    closeAction();
  };
  return {
    browser,
    process,
    get closeCalls() {
      return closeCalls;
    },
    setCloseAction(action) {
      closeAction = action;
    },
    emitDisconnected() {
      connected = false;
      browserEvents.emit('disconnected');
    },
    emitExit(code = 0, signal = null) {
      process.exitCode = code;
      process.signalCode = signal;
      process.emit('exit', code, signal);
    }
  };
}

function createFakeDependencies(
  fake: FakeBrowser,
  userDataDir: string,
  options: { cleanupFailure?: unknown } = {}
): TestBrowserLaunchDependencies & { cleanupPaths: string[]; launchedPaths: string[] } {
  const cleanupPaths: string[] = [];
  const launchedPaths: string[] = [];
  return {
    cleanupPaths,
    launchedPaths,
    async createUserDataDir() {
      return userDataDir;
    },
    async launch({ userDataDir: launchedUserDataDir }) {
      launchedPaths.push(launchedUserDataDir);
      return fake.browser;
    },
    async cleanupUserDataDir(cleanupUserDataDir) {
      cleanupPaths.push(cleanupUserDataDir);
      if (options.cleanupFailure) throw options.cleanupFailure;
    }
  };
}

async function captureFailure(action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected lifecycle operation to fail');
}

async function runOwnedBrowserLifecycleChecks(): Promise<void> {
  {
    const fake = createFakeBrowser();
    const dependencies = createFakeDependencies(fake, 'profile-success');
    fake.setCloseAction(() => {
      fake.emitDisconnected();
      fake.emitExit();
    });
    const browser = await launchOwnedTestBrowser(dependencies);
    assert.deepEqual(dependencies.launchedPaths, ['profile-success']);
    const firstClose = browser.close();
    const secondClose = browser.close();
    assert.strictEqual(firstClose, secondClose, 'duplicate close must share one disposal');
    await firstClose;
    assert.equal(fake.closeCalls, 1);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-success']);
    await browser.close();
    assert.equal(fake.closeCalls, 1, 'repeated close must not close the browser twice');
    assert.deepEqual(dependencies.cleanupPaths, ['profile-success']);
  }

  {
    const fake = createFakeBrowser();
    const launchFailure = new Error('launch failed');
    const cleanupFailure = new Error('launch cleanup failed');
    const dependencies = createFakeDependencies(fake, 'profile-launch-failure', { cleanupFailure });
    dependencies.launch = async () => {
      throw launchFailure;
    };
    const observed = await captureFailure(() => launchOwnedTestBrowser(dependencies).then(() => undefined));
    assert.ok(observed instanceof AggregateError);
    assert.deepEqual((observed as AggregateError).errors, [launchFailure, cleanupFailure]);
    assert.equal((observed as AggregateError).cause, launchFailure);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-launch-failure']);
  }

  {
    const closeFailure = new Error('browser close failed');
    const fake = createFakeBrowser({ closeFailure });
    const primary = new Error('test primary failed');
    const cleanupFailure = new Error('profile cleanup failed');
    const dependencies = createFakeDependencies(fake, 'profile-primary', { cleanupFailure });
    const browser = await launchOwnedTestBrowser(dependencies);
    const closing = closeTestBrowser(browser, primary);
    fake.emitDisconnected();
    fake.emitExit();
    const observed = await captureFailure(() => closing);
    assert.ok(observed instanceof AggregateError);
    assert.deepEqual((observed as AggregateError).errors, [
      primary,
      closeFailure,
      cleanupFailure
    ]);
    assert.equal((observed as AggregateError).cause, primary);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-primary']);
  }

  {
    const fake = createFakeBrowser();
    const exitFailure = new Error('browser process error');
    const dependencies = createFakeDependencies(fake, 'profile-late-exit');
    const browser = await launchOwnedTestBrowser(dependencies);
    const closing = browser.close();
    assert.deepEqual(dependencies.cleanupPaths, [], 'cleanup must wait for public close/exit signals');
    fake.emitDisconnected();
    fake.process.emit('error', exitFailure);
    fake.emitExit(17);
    const observed = await captureFailure(() => closing);
    assert.ok(observed instanceof AggregateError);
    assert.equal((observed as AggregateError).errors.length, 2);
    assert.equal((observed as AggregateError).errors[0], exitFailure);
    assert.match(String((observed as AggregateError).errors[1]), /exited with code 17/);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-late-exit']);
  }

  {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const firstDependencies = createFakeDependencies(first, 'profile-one');
    const secondDependencies = createFakeDependencies(second, 'profile-two');
    first.setCloseAction(() => {
      first.emitDisconnected();
      first.emitExit();
    });
    second.setCloseAction(() => {
      second.emitDisconnected();
      second.emitExit();
    });
    const [firstBrowser, secondBrowser] = await Promise.all([
      launchOwnedTestBrowser(firstDependencies),
      launchOwnedTestBrowser(secondDependencies)
    ]);
    await Promise.all([firstBrowser.close(), secondBrowser.close()]);
    assert.deepEqual(firstDependencies.cleanupPaths, ['profile-one']);
    assert.deepEqual(secondDependencies.cleanupPaths, ['profile-two']);
    assert.equal(first.closeCalls, 1);
    assert.equal(second.closeCalls, 1);
  }
}

await runOwnedBrowserLifecycleChecks();

const browser = await launchTestBrowser();
try {
  console.log(`browser launch checks passed (${await browser.version()})`);
} finally {
  await browser.close();
}
