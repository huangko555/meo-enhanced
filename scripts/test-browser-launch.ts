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
  setCloseAction(action: () => void): void;
  emitDisconnected(): void;
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
};

type FakeProfileRegistry = {
  profiles: Set<string>;
  cleanupResults: Array<{ userDataDir: string; deleted: boolean }>;
};

function createFakeBrowser(options: {
  closeFailure?: unknown;
  nonExtensible?: boolean;
  processFailure?: unknown;
} = {}): FakeBrowser {
  let closeAction = () => {};
  class FakeBrowserEvents extends EventEmitter {
    async close(): Promise<void> {
      try {
        if (options.closeFailure) throw options.closeFailure;
      } finally {
        closeAction();
      }
    }
  }
  const browserEvents = new FakeBrowserEvents();
  const process = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
  let connected = true;
  const browser = browserEvents as unknown as Browser & {
    connected: boolean;
    process(): typeof process;
    close(): Promise<void>;
  };
  Object.defineProperty(browser, 'connected', { get: () => connected });
  browser.process = () => {
    if (options.processFailure) throw options.processFailure;
    return process;
  };
  if (options.nonExtensible) Object.preventExtensions(browser);
  return {
    browser,
    process,
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
  options: { cleanupFailure?: unknown } = {},
  profileRegistry: FakeProfileRegistry = { profiles: new Set(), cleanupResults: [] }
): TestBrowserLaunchDependencies & {
  cleanupPaths: string[];
  launchedPaths: string[];
  profileRegistry: FakeProfileRegistry;
} {
  const cleanupPaths: string[] = [];
  const launchedPaths: string[] = [];
  profileRegistry.profiles.add(userDataDir);
  return {
    cleanupPaths,
    launchedPaths,
    profileRegistry,
    async createUserDataDir() {
      return userDataDir;
    },
    async launch({ userDataDir: launchedUserDataDir }) {
      launchedPaths.push(launchedUserDataDir);
      return fake.browser;
    },
    async cleanupUserDataDir(cleanupUserDataDir) {
      cleanupPaths.push(cleanupUserDataDir);
      const deleted = options.cleanupFailure === undefined && profileRegistry.profiles.delete(cleanupUserDataDir);
      profileRegistry.cleanupResults.push({ userDataDir: cleanupUserDataDir, deleted });
      if (options.cleanupFailure !== undefined) throw options.cleanupFailure;
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
    assert.deepEqual(dependencies.cleanupPaths, ['profile-success']);
    assert.equal(fake.browser.connected, false);
    assert.equal(fake.process.exitCode, 0);
    assert.deepEqual([...dependencies.profileRegistry.profiles], []);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-success', deleted: true }
    ]);
    await browser.close();
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
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-launch-failure', deleted: false }
    ]);
  }

  {
    const fake = createFakeBrowser();
    const launchFailure = new Error('shared entry launch failed');
    const cleanupFailure = new Error('shared entry cleanup failed');
    const dependencies = createFakeDependencies(fake, 'profile-shared-entry', { cleanupFailure });
    dependencies.launch = async () => {
      throw launchFailure;
    };
    const environmentKeys = [
      'MEO_TEST_BROWSER',
      'PUPPETEER_EXECUTABLE_PATH',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'LOCALAPPDATA'
    ] as const;
    const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) process.env[key] = 'Z:\\missing-browser-root';
    let observed: unknown;
    try {
      observed = await captureFailure(() => launchTestBrowser(dependencies).then(() => undefined));
    } finally {
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.ok(observed instanceof AggregateError, 'shared entry must preserve lifecycle aggregates');
    assert.deepEqual((observed as AggregateError).errors, [launchFailure, cleanupFailure]);
    assert.equal((observed as AggregateError).cause, launchFailure);
    assert.match((observed as AggregateError).message, /Failed to launch test browser/);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-shared-entry']);
  }

  {
    const setupFailure = new Error('browser process accessor failed');
    const fake = createFakeBrowser({ processFailure: setupFailure });
    fake.setCloseAction(() => {
      fake.emitDisconnected();
    });
    const dependencies = createFakeDependencies(fake, 'profile-process-setup-failure');
    const observed = await captureFailure(() => launchOwnedTestBrowser(dependencies).then(() => undefined));
    assert.ok(observed instanceof AggregateError);
    const errors = (observed as AggregateError).errors;
    assert.equal(errors[0], setupFailure);
    assert.match(String(errors[1]), /Cannot safely clean test browser profile/);
    assert.equal((observed as AggregateError).cause, setupFailure);
    assert.equal(fake.browser.connected, false);
    assert.equal(fake.process.exitCode, null);
    assert.deepEqual(dependencies.cleanupPaths, [], 'profile cleanup requires observable process terminal');
    assert.deepEqual([...dependencies.profileRegistry.profiles], ['profile-process-setup-failure']);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, []);
  }

  {
    const closeFailure = new Error('sealed browser close failed');
    const cleanupFailure = new Error('sealed profile cleanup failed');
    const fake = createFakeBrowser({ nonExtensible: true, closeFailure });
    fake.setCloseAction(() => {
      fake.emitDisconnected();
      fake.emitExit();
    });
    const dependencies = createFakeDependencies(fake, 'profile-sealed-setup-failure', { cleanupFailure });
    const observed = await captureFailure(() => launchOwnedTestBrowser(dependencies).then(() => undefined));
    assert.ok(observed instanceof AggregateError);
    const errors = (observed as AggregateError).errors;
    assert.equal(errors.length, 3);
    assert.ok(errors[0] instanceof TypeError);
    assert.equal(errors[1], closeFailure);
    assert.equal(errors[2], cleanupFailure);
    assert.equal((observed as AggregateError).cause, errors[0]);
    assert.equal(fake.browser.connected, false);
    assert.equal(fake.process.exitCode, 0);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-sealed-setup-failure']);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-sealed-setup-failure', deleted: false }
    ]);
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
    assert.deepEqual(dependencies.cleanupPaths, [], 'disconnected is not process terminal');
    assert.deepEqual([...dependencies.profileRegistry.profiles], ['profile-late-exit']);
    fake.process.emit('error', exitFailure);
    fake.emitExit(17);
    const observed = await captureFailure(() => closing);
    assert.ok(observed instanceof AggregateError);
    assert.equal((observed as AggregateError).errors.length, 2);
    assert.equal((observed as AggregateError).errors[0], exitFailure);
    assert.match(String((observed as AggregateError).errors[1]), /exited with code 17/);
    assert.deepEqual(dependencies.cleanupPaths, ['profile-late-exit']);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-late-exit', deleted: true }
    ]);
  }

  {
    const fake = createFakeBrowser();
    const dependencies = createFakeDependencies(fake, 'profile-settled-success');
    fake.setCloseAction(() => {
      fake.emitDisconnected();
      fake.emitExit();
    });
    const browser = await launchOwnedTestBrowser(dependencies);
    const settled = browser.close();
    await settled;
    assert.strictEqual(browser.close(), settled, 'settled no-primary close must reuse its promise');
    const latePrimary = new Error('late success primary');
    const late = closeTestBrowser(browser, latePrimary);
    assert.notStrictEqual(late, settled, 'late primary must not reuse a settled success promise');
    const observed = await captureFailure(() => late);
    assert.strictEqual(observed, latePrimary);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-settled-success', deleted: true }
    ]);
  }

  {
    const cleanupFailure = new Error('settled cleanup failed');
    const fake = createFakeBrowser();
    const dependencies = createFakeDependencies(fake, 'profile-settled-failure', { cleanupFailure });
    fake.setCloseAction(() => {
      fake.emitDisconnected();
      fake.emitExit();
    });
    const browser = await launchOwnedTestBrowser(dependencies);
    const settled = browser.close();
    const initial = await captureFailure(() => settled);
    assert.strictEqual(initial, cleanupFailure);
    assert.strictEqual(browser.close(), settled, 'settled no-primary failure must reuse its promise');
    const latePrimary = new Error('late failure primary');
    const late = closeTestBrowser(browser, latePrimary);
    const observed = await captureFailure(() => late);
    assert.ok(observed instanceof AggregateError);
    assert.deepEqual((observed as AggregateError).errors, [latePrimary, cleanupFailure]);
    assert.equal((observed as AggregateError).cause, latePrimary);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-settled-failure', deleted: false }
    ]);
  }

  {
    const firstPrimary = new Error('first concurrent primary');
    const secondPrimary = new Error('second concurrent primary');
    const fake = createFakeBrowser();
    const dependencies = createFakeDependencies(fake, 'profile-concurrent-primary');
    fake.setCloseAction(() => {
      fake.emitDisconnected();
      fake.emitExit();
    });
    const browser = await launchOwnedTestBrowser(dependencies);
    const first = closeTestBrowser(browser, firstPrimary);
    const second = closeTestBrowser(browser, secondPrimary);
    assert.strictEqual(first, second, 'concurrent primary closes must share one promise');
    const observed = await captureFailure(() => first);
    assert.ok(observed instanceof AggregateError);
    assert.deepEqual((observed as AggregateError).errors, [firstPrimary, secondPrimary]);
    assert.equal((observed as AggregateError).cause, firstPrimary);
    assert.deepEqual(dependencies.profileRegistry.cleanupResults, [
      { userDataDir: 'profile-concurrent-primary', deleted: true }
    ]);
  }

  {
    const first = createFakeBrowser();
    const second = createFakeBrowser();
    const profileRegistry: FakeProfileRegistry = { profiles: new Set(), cleanupResults: [] };
    const firstDependencies = createFakeDependencies(first, 'profile-one', {}, profileRegistry);
    const secondDependencies = createFakeDependencies(second, 'profile-two', {}, profileRegistry);
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
    assert.deepEqual([...profileRegistry.profiles], []);
    assert.deepEqual(profileRegistry.cleanupResults, [
      { userDataDir: 'profile-one', deleted: true },
      { userDataDir: 'profile-two', deleted: true }
    ]);
  }
}

await runOwnedBrowserLifecycleChecks();

const browser = await launchTestBrowser();
try {
  console.log(`browser launch checks passed (${await browser.version()})`);
} finally {
  await browser.close();
}
