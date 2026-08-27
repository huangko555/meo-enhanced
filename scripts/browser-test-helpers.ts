import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

export type TestBrowserLaunchOptions = {
  readonly userDataDir: string;
};

export type TestBrowserLaunchDependencies = {
  readonly createUserDataDir(): Promise<string>;
  readonly launch(options: TestBrowserLaunchOptions): Promise<Browser>;
  readonly cleanupUserDataDir(userDataDir: string): Promise<void>;
};

type OwnedBrowserState = {
  readonly userDataDir: string;
  readonly originalClose: () => Promise<void>;
  readonly process: ChildProcess | null;
  readonly cleanupUserDataDir: (userDataDir: string) => Promise<void>;
  readonly primaryErrors: unknown[];
  sealed: boolean;
  settledOutcome?: { readonly cleanupErrors: readonly unknown[] };
  closePromise?: Promise<void>;
};

const ownedBrowserStates = new WeakMap<Browser, OwnedBrowserState>();

export async function launchTestBrowser(
  dependencies?: TestBrowserLaunchDependencies
): Promise<Browser> {
  let executablePath: string | undefined;
  try {
    if (dependencies) return await launchOwnedTestBrowser(dependencies);

    executablePath = findBrowserExecutable();
    const args = ['--no-sandbox'];
    if (process.platform === 'win32' && path.basename(executablePath).toLowerCase() === 'msedge.exe') {
      // Edge can relaunch through the Windows compatibility layer, leaving Puppeteer watching a wrapper that exits.
      args.push('--edge-skip-compat-layer-relaunch');
    }
    return await launchOwnedTestBrowser({
      createUserDataDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'meo-test-browser-profile-')),
      launch: ({ userDataDir }) => puppeteer.launch({ executablePath, headless: true, args, userDataDir }),
      cleanupUserDataDir: (userDataDir) => fs.promises.rm(userDataDir, { recursive: true, force: false })
    });
  } catch (error) {
    const runtime = typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`;
    const executableContext = executablePath === undefined ? '' : `, executable: ${executablePath}`;
    const context = `Failed to launch test browser (${runtime}, ${process.platform}/${process.arch}${executableContext}).`;
    if (error instanceof AggregateError) {
      throw new AggregateError(error.errors, `${context} ${error.message}`, { cause: error.cause });
    }
    throw new Error(context, { cause: error });
  }
}

export async function launchOwnedTestBrowser(
  dependencies: TestBrowserLaunchDependencies
): Promise<Browser> {
  let userDataDir: string | undefined;
  let browser: Browser | undefined;
  let browserProcess: ChildProcess | null = null;
  let originalClose: (() => Promise<void>) | undefined;
  try {
    userDataDir = await dependencies.createUserDataDir();
    browser = await dependencies.launch({ userDataDir });
    originalClose = browser.close.bind(browser);
    browserProcess = browser.process();
    installOwnedBrowserState(browser, {
      userDataDir,
      originalClose,
      process: browserProcess,
      cleanupUserDataDir: dependencies.cleanupUserDataDir,
      primaryErrors: [],
      sealed: false
    });
    return browser;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (browser !== undefined) {
      try {
        const closeErrors = await closeBrowserAndWait(
          browser,
          browserProcess,
          originalClose ?? browser.close.bind(browser)
        );
        for (const closeError of closeErrors) appendFlat(cleanupErrors, closeError);
      } catch (closeError) {
        appendFlat(cleanupErrors, closeError);
      }
    }
    if (userDataDir !== undefined) {
      try {
        await dependencies.cleanupUserDataDir(userDataDir);
      } catch (cleanupError) {
        appendFlat(cleanupErrors, cleanupError);
      }
    }
    throwLifecycleErrors([error], cleanupErrors, 'Test browser launch and cleanup failed');
  }
}

export function closeTestBrowser(browser: Browser, primary?: unknown): Promise<void> {
  const state = ownedBrowserStates.get(browser);
  if (!state) return browser.close();
  const hasPrimary = arguments.length > 1;
  if (state.sealed) {
    if (!hasPrimary) return state.closePromise!;
    return rejectLatePrimary(primary, state.settledOutcome!.cleanupErrors);
  }
  if (hasPrimary) appendFlat(state.primaryErrors, primary);
  state.closePromise ??= disposeOwnedBrowser(browser, state);
  return state.closePromise;
}

function installOwnedBrowserState(browser: Browser, state: OwnedBrowserState): void {
  Object.defineProperty(browser, 'close', {
    configurable: true,
    writable: true,
    value: () => closeTestBrowser(browser)
  });
  ownedBrowserStates.set(browser, state);
}

async function disposeOwnedBrowser(browser: Browser, state: OwnedBrowserState): Promise<void> {
  const cleanupErrors = await closeBrowserAndWait(browser, state.process, state.originalClose);

  try {
    await state.cleanupUserDataDir(state.userDataDir);
  } catch (error) {
    appendFlat(cleanupErrors, error);
  }

  state.sealed = true;
  state.settledOutcome = { cleanupErrors: [...cleanupErrors] };
  throwLifecycleErrors(state.primaryErrors, cleanupErrors, 'Test browser close and cleanup failed');
}

async function rejectLatePrimary(
  primary: unknown,
  cleanupErrors: readonly unknown[]
): Promise<void> {
  throwLifecycleErrors([primary], cleanupErrors, 'Test browser late primary and cleanup failed');
}

async function closeBrowserAndWait(
  browser: Browser,
  process: ChildProcess | null,
  close: () => Promise<void>
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  let disconnected = Promise.resolve();
  try {
    disconnected = waitForDisconnected(browser);
  } catch (error) {
    appendFlat(cleanupErrors, error);
  }
  let processExit = Promise.resolve<unknown[]>([]);
  try {
    processExit = waitForProcessExit(process);
  } catch (error) {
    appendFlat(cleanupErrors, error);
  }

  try {
    await close();
  } catch (error) {
    appendFlat(cleanupErrors, error);
  }

  const [, processExitErrors] = await Promise.all([disconnected, processExit]);
  for (const error of processExitErrors) appendFlat(cleanupErrors, error);
  return cleanupErrors;
}

function waitForDisconnected(browser: Browser): Promise<void> {
  if (!browser.connected) return Promise.resolve();
  return new Promise((resolve) => {
    browser.once('disconnected', () => resolve());
  });
}

function waitForProcessExit(process: ChildProcess | null): Promise<unknown[]> {
  if (!process) return Promise.resolve([]);
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve(processExitErrors(process.exitCode, process.signalCode));
  }

  return new Promise((resolve) => {
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      process.removeListener('error', onError);
      process.removeListener('exit', onExit);
      errors.push(...processExitErrors(code, signal));
      resolve(errors);
    };
    process.once('error', onError);
    process.once('exit', onExit);
  });
}

function processExitErrors(code: number | null, signal: NodeJS.Signals | null): unknown[] {
  const errors: unknown[] = [];
  if (code !== null && code !== 0) errors.push(new Error(`Test browser process exited with code ${code}`));
  if (signal !== null) errors.push(new Error(`Test browser process exited with signal ${signal}`));
  return errors;
}

function appendFlat(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendFlat(target, nested);
    return;
  }
  target.push(error);
}

function throwLifecycleErrors(
  primaryErrors: readonly unknown[],
  cleanupErrors: readonly unknown[],
  message: string
): void {
  const flatPrimaryErrors: unknown[] = [];
  const flatCleanupErrors: unknown[] = [];
  for (const error of primaryErrors) appendFlat(flatPrimaryErrors, error);
  for (const error of cleanupErrors) appendFlat(flatCleanupErrors, error);

  if (flatPrimaryErrors.length > 0 && flatCleanupErrors.length > 0) {
    throw new AggregateError(
      [...flatPrimaryErrors, ...flatCleanupErrors],
      message,
      { cause: flatPrimaryErrors[0] }
    );
  }
  if (flatPrimaryErrors.length === 1) throw flatPrimaryErrors[0];
  if (flatPrimaryErrors.length > 1) {
    throw new AggregateError(flatPrimaryErrors, message, { cause: flatPrimaryErrors[0] });
  }
  if (flatCleanupErrors.length === 1) throw flatCleanupErrors[0];
  if (flatCleanupErrors.length > 1) {
    throw new AggregateError(flatCleanupErrors, message, { cause: flatCleanupErrors[0] });
  }
}

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...platformBrowserCandidates()
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

function platformBrowserCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
    const programFiles = process.env.PROGRAMFILES ?? 'C:/Program Files';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    return [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium'
  ];
}
