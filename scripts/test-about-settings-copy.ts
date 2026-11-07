import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { testFeedbackVersionPopover } from './feedback-version-test-helper';

const entry = path.resolve('scripts/test-about-settings-copy-entry.ts');
const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const artifactRoot = path.resolve('.local/about-copy-regression');
await fs.mkdir(artifactRoot, { recursive: true });
const diagnosisDirectory = await fs.mkdtemp(path.join(artifactRoot, 'run-'));
const combinations = [
  { language: 'en', appearance: 'light' },
  { language: 'en', appearance: 'dark' },
  { language: 'zh-CN', appearance: 'light' },
  { language: 'zh-CN', appearance: 'dark' }
] as const;
type Combination = (typeof combinations)[number];

type Sample = {
  readonly tooltip: string | null;
  readonly opacity: string;
  readonly color: string;
  readonly background: string;
  readonly text: string;
  readonly label: string | null;
  readonly ariaBusy: string | null;
  readonly disabled: boolean;
  readonly svgMarkup: string;
  readonly cardTop: number;
  readonly cardHeight: number;
  readonly focused: boolean;
};

function isCopyingHint(value: string | null): boolean {
  return value !== null && /Copying|正在复制/.test(value);
}

async function sample(page: Page): Promise<Sample> {
  return page.$eval('.settings-about-copy', (element: Element) => {
    const button = element as HTMLButtonElement;
    const style = getComputedStyle(button);
    const card = document.querySelector('.settings-about-runtime')!.getBoundingClientRect();
    const hint = document.querySelector('.meo-tooltip.is-visible');
    const tooltip = hint && getComputedStyle(hint).visibility === 'visible' && getComputedStyle(hint).opacity === '1' ? hint : null;
    return {
      tooltip: tooltip?.textContent ?? null,
      opacity: style.opacity,
      color: style.color,
      background: style.backgroundColor,
      text: button.textContent ?? '',
      label: button.getAttribute('aria-label'),
      ariaBusy: button.getAttribute('aria-busy'),
      disabled: button.disabled,
      svgMarkup: button.querySelector('svg')?.outerHTML ?? '',
      cardTop: card.top,
      cardHeight: card.height,
      focused: document.activeElement === button
    };
  });
}

async function setup(page: Page, combination: Combination, script: string): Promise<void> {
  await page.evaluate(() => {
    const scope = window as any;
    scope.tooltipBinding?.dispose();
    scope.aboutCopyFixture?.about.dispose();
  });
  await page.setViewport({ width: 390, height: 780 });
  await page.setContent('<!doctype html><style>html,body{margin:0;height:100%}</style><body>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: script });
  await page.evaluate(({ language, appearance }) => {
    const scope = window as any;
    scope.AboutCopyHarness.applyBuiltInVisualBaseline(appearance);
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-window';
    dialog.dataset.tab = 'about';
    const content = document.createElement('main');
    content.className = 'settings-content';
    dialog.append(content);
    document.body.append(dialog);
    scope.copyCalls = [];
    scope.resolveCopy = null;
    const about = scope.AboutCopyHarness.createAboutSettings({
      productVersion: '0.4.0-test',
      logoUrl: '',
      openLink() {},
      async readEnvironment() {
        return { appName: 'Visual Studio Code', appVersion: '1.143.1-test', system: 'Windows 11', architecture: 'x64', remoteName: '' };
      },
      copyText(text: string) {
        scope.copyCalls.push(text);
        return new Promise<boolean>(resolve => { scope.resolveCopy = resolve; });
      }
    });
    content.append(about.render(language, scope.AboutCopyHarness.aboutCatalog));
    scope.tooltipBinding = scope.AboutCopyHarness.bindTooltips(document.body);
    dialog.showModal();
    about.open();
    scope.aboutCopyFixture = { copyCalls: scope.copyCalls, resolveCopy: null, about, dialog };
  }, combination);
  await page.waitForSelector('.settings-window[open][data-tab="about"]');
  await page.waitForSelector('.settings-about-copy:not([disabled])');
}

async function startPendingCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as any;
    scope.pendingFrames = [];
    {
      let count = 0;
      const capture = () => {
        const button = document.querySelector<HTMLButtonElement>('.settings-about-copy')!;
        const hint = document.querySelector('.meo-tooltip.is-visible');
        const tooltip = hint && getComputedStyle(hint).visibility === 'visible' && getComputedStyle(hint).opacity === '1' ? hint : null;
        const style = getComputedStyle(button);
        const card = document.querySelector('.settings-about-runtime')!.getBoundingClientRect();
        scope.pendingFrames.push({
          tooltip: tooltip?.textContent ?? null,
          opacity: style.opacity,
          color: style.color,
          background: style.backgroundColor,
          text: button.textContent ?? '',
          label: button.getAttribute('aria-label'),
          ariaBusy: button.getAttribute('aria-busy'),
          disabled: button.disabled,
          svgMarkup: button.querySelector('svg')?.outerHTML ?? '',
          cardTop: card.top,
          cardHeight: card.height,
          focused: document.activeElement === button
        });
        if (++count < 4) requestAnimationFrame(capture);
      };
      document.querySelector('.settings-about-copy')!.addEventListener('click', capture, { once: true });
    }
  });
}

async function resolveCopy(page: Page, success: boolean): Promise<void> {
  await page.evaluate(success => {
    const scope = window as any;
    const resolve = scope.resolveCopy;
    scope.resolveCopy = null;
    if (!resolve) throw new Error('copy callback was not pending');
    resolve(success);
  }, success);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const browser = await launchTestBrowser();
const results: unknown[] = [];
let failure: unknown;
try {
  const script = await build.outputs[0].text();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  for (const combination of combinations) {
    await setup(page, combination, script);
    await page.hover('.settings-about-copy');
    await page.waitForFunction(() => {
      const hint = document.querySelector('.meo-tooltip.is-visible');
      return hint && getComputedStyle(hint).visibility === 'visible' && getComputedStyle(hint).opacity === '1';
    });
    const before = await sample(page);
    await page.evaluate(() => { (window as any).beforeCopySvg = document.querySelector('.settings-about-copy svg'); });
    const beforeCard = { top: before.cardTop, height: before.cardHeight };

    await startPendingCapture(page);
    await page.click('.settings-about-copy');
    await page.waitForFunction(() => (window as any).pendingFrames.length === 4);
    const pendingFrames = await page.evaluate(() => (window as any).pendingFrames as Sample[]);
    assert.equal(pendingFrames.length, 4, `${combination.language}/${combination.appearance}: capture exactly four pending RAF frames`);
    assert.equal(pendingFrames.every(frame => !isCopyingHint(frame.tooltip)), true,
      `${combination.language}/${combination.appearance}: visible tooltip never says Copying while pending`);

    for (const pending of pendingFrames) {
      assert.equal(pending.opacity, before.opacity, `${combination.language}/${combination.appearance}: pending opacity is stable`);
      assert.equal(pending.color, before.color, `${combination.language}/${combination.appearance}: pending text color is stable`);
      assert.equal(pending.background, before.background, `${combination.language}/${combination.appearance}: pending hover background is stable`);
      assert.equal(pending.text, before.text, `${combination.language}/${combination.appearance}: pending button text is stable`);
      assert.equal(pending.svgMarkup, before.svgMarkup, `${combination.language}/${combination.appearance}: pending SVG content is stable`);
      assert.equal(pending.disabled, false, `${combination.language}/${combination.appearance}: pending copy remains enabled`);
      assert.equal(pending.ariaBusy, 'true', `${combination.language}/${combination.appearance}: pending copy exposes aria-busy`);
      assert.equal(pending.focused, true, `${combination.language}/${combination.appearance}: pending copy retains focus`);
      assert.equal(pending.label, before.label);
      assert.equal(pending.tooltip, before.tooltip);
      assert.ok(Math.abs(pending.cardTop - beforeCard.top) <= .5);
      assert.ok(Math.abs(pending.cardHeight - beforeCard.height) <= .5);
    }
    assert.equal(await page.evaluate(() => document.querySelector('.settings-about-copy svg') === (window as any).beforeCopySvg), true,
      `${combination.language}/${combination.appearance}: pending retains the same SVG node`);
    assert.equal((await page.evaluate(() => (window as any).copyCalls)).length, 1,
      `${combination.language}/${combination.appearance}: first copy writes once`);

    await page.click('.settings-about-copy');
    assert.equal((await page.evaluate(() => (window as any).copyCalls)).length, 1,
      `${combination.language}/${combination.appearance}: pending second click is guarded`);
    await resolveCopy(page, true);
    const success = await sample(page);
    assert.equal(success.label, combination.language === 'en' ? 'Copied' : '已复制');
    assert.match(success.svgMarkup, /M20 6 9 17l-5-5/, `${combination.language}/${combination.appearance}: success uses Check icon`);
    assert.equal(success.disabled, false);
    assert.equal(success.ariaBusy, null);
    assert.equal(success.focused, true);
    assert.ok(Math.abs(success.cardTop - beforeCard.top) <= .5);
    assert.ok(Math.abs(success.cardHeight - beforeCard.height) <= .5);
    const copiedText = await page.evaluate(() => (window as any).copyCalls[0]);
    assert.equal(copiedText, 'MEO Enhanced: 0.4.0-test\nVisual Studio Code: 1.143.1-test\nOS: Windows 11 (x64)');

    await startPendingCapture(page);
    await page.click('.settings-about-copy');
    await page.waitForFunction(() => (window as any).pendingFrames.length === 4);
    const repeatedFrames = await page.evaluate(() => (window as any).pendingFrames as Sample[]);
    for (const repeatedPending of repeatedFrames) {
      assert.equal(repeatedPending.svgMarkup, success.svgMarkup, `${combination.language}/${combination.appearance}: repeat pending retains Check icon`);
      assert.equal(repeatedPending.tooltip, success.tooltip);
      assert.equal(repeatedPending.opacity, success.opacity);
      assert.equal(repeatedPending.focused, true);
    }
    assert.equal((await page.evaluate(() => (window as any).copyCalls)).length, 2);
    await resolveCopy(page, true);
    await page.screenshot({ path: path.join(diagnosisDirectory, `${combination.language}-${combination.appearance}.png`) });

    await page.click('.settings-about-copy');
    await resolveCopy(page, false);
    const failed = await sample(page);
    assert.equal(failed.label, combination.language === 'en' ? 'Copy version info' : '复制版本信息');
    const failureText = await page.$eval('.settings-about-status', element => element.textContent);
    assert.match(failureText!, /Unable to copy|复制失败/);
    assert.equal(await page.$eval('.settings-about-status', element => !element.hasAttribute('hidden') && element.classList.contains('is-error')), true);
    await page.click('.settings-about-copy');
    assert.equal(await page.$eval('.settings-about-status', element => element.textContent), failureText, 'Retry keeps the failure feedback until it has a new result');
    assert.equal((await sample(page)).cardHeight, failed.cardHeight, 'Retry does not collapse the failure message');
    await resolveCopy(page, true);
    assert.equal(await page.$eval('.settings-about-status', element => element.classList.contains('is-error')), false);

    await page.evaluate(() => {
      const scope = window as any;
      scope.resolveCopy = null;
      scope.aboutCopyFixture.about.close();
      scope.aboutCopyFixture.dialog.close();
      scope.aboutCopyFixture.dialog.showModal();
      scope.aboutCopyFixture.about.open();
    });
    await page.waitForSelector('.settings-about-copy:not([disabled])');
    await page.click('.settings-about-copy');
    await page.evaluate(() => {
      const scope = window as any;
      scope.aboutCopyFixture.about.close();
      scope.aboutCopyFixture.dialog.close();
      scope.aboutCopyFixture.dialog.showModal();
      scope.aboutCopyFixture.about.open();
      scope.lateResolve = scope.resolveCopy;
      scope.resolveCopy = null;
    });
    await page.evaluate(() => { const resolve = (window as any).lateResolve; if (resolve) resolve(true); });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.$eval('.settings-about-copy', element => element.getAttribute('aria-label')), combination.language === 'en' ? 'Copy version info' : '复制版本信息');
    assert.equal(await page.$eval('.settings-about-copy', element => element.getAttribute('aria-busy')), null, 'A late result cannot revive the closed copy operation');
    results.push({ combination, pendingFrames, success });
    console.log(`${combination.language}/${combination.appearance}: passed`);
  }
  await testFeedbackVersionPopover(page, script, diagnosisDirectory);
  assert.deepEqual(errors, [], 'The production About and feedback copy interactions have no browser errors');
} catch (error) {
  failure = error;
  await fs.writeFile(path.join(diagnosisDirectory, 'failure.json'), JSON.stringify({ error: String(error), results }, null, 2));
  throw error;
} finally {
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
