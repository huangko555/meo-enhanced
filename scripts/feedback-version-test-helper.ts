import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

/** Exercise production adapters with trusted input, shared About data, and observable timer transitions. */
export async function testFeedbackVersionPopover(ownerPage: Page, script: string, artifacts: string) {
  for (const language of ['zh-CN', 'en'] as const) for (const appearance of ['light', 'dark'] as const) {
    const page = await ownerPage.browser().newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 800, height: 700 });
    await page.setContent('<!doctype html><style>html,body{margin:0}</style><body>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addScriptTag({ content: script });
    await page.evaluate(({ language, appearance }) => {
      const scope = window as any, harness = scope.AboutCopyHarness;
      harness.applyBuiltInVisualBaseline(appearance);
      const menu = document.createElement('div'); menu.className = 'more-tools-panel';
      Object.assign(menu.style, { position: 'fixed', top: '60px', right: '16px' });
      const anchor = document.createElement('button'); anchor.className = 'more-tools-option more-tools-navigation-option more-tools-feedback-link'; anchor.type = 'button';
      anchor.innerHTML = language === 'zh-CN' ? '<span>遇到问题或有建议？</span><span>去反馈 ↗</span>' : '<span>Questions or ideas?</span><span>Give feedback ↗</span>';
      const next = document.createElement('button'); next.className = 'more-tools-option'; next.type = 'button'; next.textContent = 'Support';
      const settings = document.createElement('div'); settings.style.height = '180px'; settings.style.flexShrink = '0';
      for (const text of (language === 'zh-CN' ? ['界面设置', '编辑器外观', '界面语言', '字号大小', '更多设置', '关于与支持'] : ['Interface', 'Appearance', 'Language', 'Font size', 'More settings', 'About & support'])) {
        const row = document.createElement('div'); row.className = 'more-tools-navigation-option'; row.textContent = text; settings.append(row);
      }
      menu.append(settings, anchor, next); document.body.append(menu);
      scope.reads = 0; scope.writes = []; scope.readFailure = false; scope.copySuccess = true; scope.heldCopy = false;
      const source = harness.createVersionInformationSource({
        productVersion: '0.4.0-test',
        async readEnvironment() {
          scope.reads++;
          if (scope.readFailure) { scope.readFailure = false; return null; }
          return { appName: 'Visual Studio Code', appVersion: '1.143.1-test',
            system: appearance === 'light' ? 'Windows 11 Pro (10.0.26200)' : 'Linux 6.8.0',
            architecture: appearance === 'light' ? 'x64' : 'arm64', remoteName: appearance === 'light' ? '' : 'ssh-remote' };
        },
        async copyText(text: string) { scope.writes.push(text); return scope.heldCopy ? new Promise(resolve => { scope.resolveCopy = resolve; }) : scope.copySuccess; }
      });
      const information = harness.createVersionInformation({ ...source, compact: true });
      const popover = harness.createFeedbackVersionPopover({ anchor, menu, information, focusNext: () => next.focus() });
      popover.setLanguage(language);
      const popup = document.querySelector<HTMLElement>('.feedback-version-popover')!;
      const timing = scope.feedbackTiming = { transitions: [], events: [], entered: 0, left: 0 };
      for (const target of [anchor, popup, next]) for (const type of ['focusin', 'focusout', 'keydown']) target.addEventListener(type, event => timing.events.push({ type: event.type, key: (event as KeyboardEvent).key, target: target.className, at: performance.now() }));
      anchor.addEventListener('pointerenter', () => { if (!timing.entered) timing.entered = performance.now(); });
      anchor.addEventListener('pointerleave', () => { timing.left = performance.now(); });
      new MutationObserver(() => timing.transitions.push({ hidden: popup.hidden, at: performance.now() })).observe(popup, { attributes: true, attributeFilter: ['hidden'] });
      scope.feedbackFixture = { popover, source, anchor, menu, next };
    }, { language, appearance });
    const expectedReads = language === 'zh-CN' && appearance === 'light' ? 2 : 1;
    if (expectedReads === 2) await page.evaluate(() => { (window as any).readFailure = true; });
    assert.equal(await page.evaluate(() => (window as any).reads), 0, 'Environment is lazy');
    await page.hover('.more-tools-feedback-link');
    await page.waitForSelector('.feedback-version-popover:not([hidden])');
    const revealDelay = await page.evaluate(() => { const s = (window as any).feedbackTiming; return s.transitions.find((v: any) => !v.hidden).at - s.entered; });
    assert.ok(revealDelay >= 175 && revealDelay < 1000, `Reveal waits 180ms (${revealDelay})`);
    if (expectedReads === 2) {
      await page.waitForSelector('.feedback-version-retry:not([hidden])');
      await page.click('.feedback-version-retry');
      await page.mouse.move(5, 600, { steps: 5 });
      await page.hover('.more-tools-feedback-link');
    }
    await page.waitForSelector('.feedback-version-copy:not([disabled])');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.feedback-version-popover')!.getBoundingClientRect();
      const menu = document.querySelector('.more-tools-panel')!.getBoundingClientRect();
      return Math.abs(popup.bottom - menu.bottom) <= 0.5;
    });
    assert.equal(await page.$eval('.feedback-version-popover', e => (e as HTMLElement).dataset.side), 'left');
    const geometry = await page.evaluate(() => {
      const popup = document.querySelector('.feedback-version-popover')!.getBoundingClientRect();
      const menu = document.querySelector('.more-tools-panel')!.getBoundingClientRect();
      const copyStyle = getComputedStyle(document.querySelector('.feedback-version-copy')!);
      const note = document.querySelector('.feedback-version-status') as HTMLElement;
      const noteStyle = getComputedStyle(note);
      const valuesStyle = getComputedStyle(document.querySelector('.feedback-version-values')!);
      return { gap: menu.left - popup.right, height: popup.height, bottomDifference: popup.bottom - menu.bottom,
        iconOnly: document.querySelector('.feedback-version-copy')!.textContent === '' && !!document.querySelector('.feedback-version-copy > svg'),
        copyBorder: copyStyle.borderTopStyle !== 'none' && parseFloat(copyStyle.borderTopWidth) > 0,
        valuesBorder: valuesStyle.borderTopStyle !== 'none' && parseFloat(valuesStyle.borderTopWidth) > 0,
        valuesFontSize: parseFloat(valuesStyle.fontSize),
        valuesFontWeights: [...document.querySelectorAll('.feedback-version-values dt, .feedback-version-values dd')].map(e => getComputedStyle(e).fontWeight),
        noteHidden: note.hidden, noteText: note.textContent,
        noteLines: (note.clientHeight - parseFloat(noteStyle.paddingTop) - parseFloat(noteStyle.paddingBottom)) / parseFloat(noteStyle.lineHeight),
        noteSeparator: parseFloat(noteStyle.borderTopWidth) > 0 };
    });
    assert.ok(geometry.gap >= 0 && geometry.gap <= 2.5, 'The version popover stays close to its parent menu');
    assert.equal(geometry.iconOnly, true, 'Copy uses an icon with an accessible label');
    assert.equal(geometry.copyBorder, true, 'The icon button has a visible frame');
    assert.ok(Math.abs(geometry.bottomDifference) <= 0.5, 'The popover bottom aligns with the settings menu bottom');
    assert.equal(geometry.valuesBorder, false, 'Version entries have no inner frame');
    assert.equal(geometry.valuesFontSize, 11, 'Version entries use the smaller text size');
    assert.ok(geometry.valuesFontWeights.every(weight => weight === '400'), 'Version labels and values use regular weight');
    assert.equal(geometry.noteHidden, false, 'The footer hint remains visible');
    assert.equal(geometry.noteSeparator, true, 'The footer retains its separator');
    assert.equal(geometry.noteText, language === 'en' ? 'Include this in your feedback.' : '反馈时可附上这些信息');
    assert.ok(geometry.noteLines <= 2, 'The complete feedback hint uses at most two lines');
    if (appearance === 'light') {
      assert.ok(geometry.height <= 160, 'The footer sizes to its contents without reserving extra whitespace');
    } else assert.match(await page.$eval('.feedback-version-values', e => e.textContent), /ssh-remote/);
    await page.mouse.move(5, 600, { steps: 5 });
    await page.waitForSelector('.feedback-version-popover[hidden]').catch(async error => {
      console.log('Feedback dismissal state:', await page.evaluate(() => ({
        anchorHovered: document.querySelector('.more-tools-feedback-link')!.matches(':hover'),
        popoverHovered: document.querySelector('.feedback-version-popover')!.matches(':hover'),
        focused: document.activeElement?.tagName,
        focusVisible: [...document.querySelectorAll(':focus-visible')].map(e => e.outerHTML),
        timing: (window as any).feedbackTiming
      })));
      throw error;
    });
    const hideDelay = await page.evaluate(() => { const s = (window as any).feedbackTiming; return s.transitions.filter((v: any) => v.hidden).at(-1).at - s.left; });
    assert.ok(hideDelay >= 175 && hideDelay < 1000, `Dismissal waits 180ms (${hideDelay})`);
    await page.hover('.more-tools-feedback-link');
    await page.waitForSelector('.feedback-version-popover:not([hidden])');
    const gap = await page.$eval('.feedback-version-popover', e => { const r = e.getBoundingClientRect(); return { x: r.right + 1, y: r.top + 20 }; });
    await page.mouse.move(gap.x, gap.y, { steps: 5 });
    await page.hover('.feedback-version-copy');
    await page.click('.feedback-version-copy');
    await page.waitForFunction(() => /已复制|Copied/.test(document.querySelector('.feedback-version-copy')!.getAttribute('aria-label')!));
    assert.equal(await page.$eval('.feedback-version-popover', e => (e as HTMLElement).hidden), false, 'Crossing the gap and copying keeps the popover open');
    assert.equal(await page.$eval('.more-tools-panel', e => (e as HTMLElement).hidden), false);
    assert.equal(await page.evaluate(() => (window as any).writes[0]), 'MEO Enhanced: 0.4.0-test\nVisual Studio Code: 1.143.1-test\n'
      + (appearance === 'light' ? 'OS: Windows 11 Pro (10.0.26200) (x64)' : 'OS: Linux 6.8.0 (arm64)\nRemote: ssh-remote'));
    assert.equal(await page.$eval('.feedback-version-copy', e => e.textContent), '', 'Success still uses only the check icon');
    assert.equal(await page.$eval('.feedback-version-popover', e => e.getBoundingClientRect().height), geometry.height, 'Copy feedback does not add footer space');
    await page.screenshot({ path: path.join(artifacts, `feedback-${language}-${appearance}.png`) });
    await page.waitForFunction(() => !/已复制|Copied/.test(document.querySelector('.feedback-version-copy')!.getAttribute('aria-label')!), { timeout: 3000 });
    await page.evaluate(() => { (window as any).copySuccess = false; });
    await page.click('.feedback-version-copy');
    await page.waitForFunction(() => document.querySelector('.feedback-version-status')?.classList.contains('is-error'));
    await page.evaluate(() => { (window as any).copySuccess = true; });
    await page.click('.feedback-version-copy');
    await page.waitForFunction(() => !document.querySelector('.feedback-version-status')?.classList.contains('is-error'));
    await page.evaluate(() => { (window as any).heldCopy = true; });
    await page.click('.feedback-version-copy');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.more-tools-feedback-link', e => e === document.activeElement), true);
    assert.equal(await page.$eval('.feedback-version-popover', e => (e as HTMLElement).hidden), true);
    await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => { (window as any).resolveCopy(true); });
    // Let the reopened surface paint and receive its pointer transition before
    // the next keyboard gesture; otherwise both gestures share one old hit test.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.$eval('.feedback-version-copy', e => /已复制|Copied/.test(e.getAttribute('aria-label')!)), false, 'Closed copies cannot restore stale success feedback');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).feedbackFixture.next), true, 'Tab exits to the next menu item');
    await page.waitForSelector('.feedback-version-popover[hidden]');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    await page.waitForSelector('.feedback-version-popover:not([hidden])').catch(async error => { console.log('Keyboard reentry:', JSON.stringify(await page.evaluate(() => ({ timing: (window as any).feedbackTiming, focus: document.activeElement?.className })), null, 2)); throw error; });
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('.feedback-version-copy', e => e === document.activeElement), true);
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval('.more-tools-feedback-link', e => e === document.activeElement), true);
    await page.evaluate(() => {
      const s = window as any, h = s.AboutCopyHarness;
      s.sharedAbout = h.createAboutSettings({ ...s.feedbackFixture.source, logoUrl: '', openLink() {} });
      document.body.append(s.sharedAbout.render('en', h.aboutCatalog)); s.sharedAbout.open();
    });
    await page.waitForSelector('.settings-about-copy:not([disabled])');
    assert.equal(await page.evaluate(() => (window as any).reads), expectedReads, 'About reuses the same host snapshot, including after a retry');
    await page.evaluate(() => {
      const fixture = (window as any).feedbackFixture;
      fixture.menu.style.left = '16px'; fixture.menu.style.right = 'auto'; fixture.popover.reposition();
    });
    await page.waitForFunction(() => {
      const popup = document.querySelector<HTMLElement>('.feedback-version-popover')!, menu = document.querySelector('.more-tools-panel')!;
      return popup.dataset.side === 'right' && Math.abs(popup.getBoundingClientRect().bottom - menu.getBoundingClientRect().bottom) <= 0.5;
    });
    await page.evaluate(() => {
      const fixture = (window as any).feedbackFixture;
      fixture.menu.style.left = ''; fixture.menu.style.right = '16px'; fixture.popover.reposition();
    });
    await page.setViewport({ width: 320, height: 450 });
    await page.waitForFunction(() => {
      const e = document.querySelector<HTMLElement>('.feedback-version-popover')!, r = e.getBoundingClientRect();
      return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8;
    });
    assert.equal(await page.$eval('.feedback-version-information', e => e.scrollWidth <= e.clientWidth), true, 'Narrow layout does not overflow');
    await page.screenshot({ path: path.join(artifacts, `feedback-narrow-${language}-${appearance}.png`) });
    await page.evaluate(language => { (window as any).feedbackFixture.popover.setLanguage(language); }, language === 'en' ? 'zh-CN' : 'en');
    assert.equal(await page.$eval('.feedback-version-title', e => e.textContent), language === 'en' ? '版本信息' : 'Version information', 'An already-open popover changes language');
    await page.evaluate(() => { const s = window as any; s.feedbackFixture.popover.dispose(); s.sharedAbout.dispose(); });
    assert.equal(await page.$('.feedback-version-popover'), null, 'Disposal removes the portal and cancels its timers');
    assert.deepEqual(errors, [], 'The feedback interaction has no browser errors');
    await page.close();
    console.log(`Feedback versions ${language}/${appearance}: 180ms reveal/dismissal, pointer bridge, copy/retry, late completion, keyboard, shared snapshot and narrow layout passed`);
  }
}
