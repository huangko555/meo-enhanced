import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type BrowserDiscoveryRuntime = {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isExecutableFile: (filePath: string) => Promise<boolean>;
};

export async function findPdfBrowserExecutablePath(
  configuredPath?: string,
  runtime: BrowserDiscoveryRuntime = {
    platform: process.platform,
    env: process.env,
    isExecutableFile
  }
): Promise<string> {
  const candidates = uniqueNonEmpty([
    configuredPath,
    runtime.env.CHROME_PATH,
    ...platformBrowserCandidates(runtime.platform, runtime.env)
  ]);

  for (const candidate of candidates) {
    if (await runtime.isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No supported Chrome/Edge/Chromium executable was found for ${runtime.platform}. Install one and retry.`
  );
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsSync.constants.X_OK);
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function platformBrowserCandidates(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): string[] {
  if (platform === 'darwin') {
    const userApplications = env.HOME
      ? path.posix.join(env.HOME, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      : undefined;
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      userApplications ?? '',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? '';
    const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';

    return [
      path.win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      path.win32.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
      path.win32.join(local, 'Chromium', 'Application', 'chrome.exe'),
      path.win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium'
  ];
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = `${value ?? ''}`.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
