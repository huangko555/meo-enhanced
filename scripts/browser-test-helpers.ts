import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

export async function launchTestBrowser(): Promise<Browser> {
  const executablePath = findBrowserExecutable();
  const args = ['--no-sandbox'];

  if (process.platform === 'win32' && path.basename(executablePath).toLowerCase() === 'msedge.exe') {
    // Edge can relaunch through the Windows compatibility layer, leaving Puppeteer watching a wrapper that exits.
    args.push('--edge-skip-compat-layer-relaunch');
  }

  try {
    return await puppeteer.launch({ executablePath, headless: true, args });
  } catch (error) {
    const runtime = typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`;
    throw new Error(
      `Failed to launch test browser (${runtime}, ${process.platform}/${process.arch}, executable: ${executablePath}).`,
      { cause: error }
    );
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
