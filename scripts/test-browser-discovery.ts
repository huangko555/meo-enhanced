import assert from 'node:assert/strict';
import path from 'node:path';
import { findPdfBrowserExecutablePath } from '../src/export/browserDiscovery';

type Platform = 'win32' | 'darwin' | 'linux';

async function discover(
  platform: Platform,
  existingPath: string,
  env: Record<string, string | undefined> = {}
): Promise<{ found: string; examined: string[] }> {
  const examined: string[] = [];
  const found = await findPdfBrowserExecutablePath(undefined, {
    platform,
    env,
    isExecutableFile: async (candidate) => {
      examined.push(candidate);
      return candidate === existingPath;
    }
  });
  return { found, examined };
}

const windowsEnv = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local'
};
const windowsChromium = path.win32.join(
  windowsEnv.LOCALAPPDATA,
  'Chromium',
  'Application',
  'chrome.exe'
);
const windows = await discover('win32', windowsChromium, windowsEnv);
assert.equal(windows.found, windowsChromium);
assert.ok(windows.examined.includes(windowsChromium));

const macChromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
assert.equal((await discover('darwin', macChromium)).found, macChromium);
const userMacChromium = '/Users/fixture/Applications/Chromium.app/Contents/MacOS/Chromium';
assert.equal((await discover('darwin', userMacChromium, { HOME: '/Users/fixture' })).found, userMacChromium);

const linuxChromium = '/usr/bin/chromium';
assert.equal((await discover('linux', linuxChromium)).found, linuxChromium);

const override = '/fixture/browser';
assert.equal(
  await findPdfBrowserExecutablePath(` ${override} `, {
    platform: 'linux',
    env: { CHROME_PATH: '/ignored/env/browser' },
    isExecutableFile: async (candidate) => candidate === override
  }),
  override,
  'call-level fallback must remain first'
);

await assert.rejects(
  findPdfBrowserExecutablePath(undefined, {
    platform: 'darwin',
    env: {},
    isExecutableFile: async () => false
  }),
  /Chrome\/Edge\/Chromium.*darwin/i
);

console.log('Browser discovery contract passed.');
