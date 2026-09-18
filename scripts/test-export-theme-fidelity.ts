import darkPlus from '@shikijs/themes/dark-plus';
import { codeToTokens } from 'shiki';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import exportRuntime from '../src/export/runtime';
import type { CodeThemeDto } from '../src/protocol/hostConfigurationEvents';
import { resolveFinalCodePalette, type RawCodeTheme } from '../webview/src/application/finalCodePalette';
import { launchTestBrowser } from './browser-test-helpers';

const code = [
  'type User = {',
  '  id: string;',
  '};',
  'function hello(user: User) {',
  '  return `Hello, ${user.id}`;',
  '}'
].join('\n');
const codeTheme = darkPlus as CodeThemeDto;
const palette = resolveFinalCodePalette(
  codeTheme as RawCodeTheme,
  codeTheme as RawCodeTheme,
  'dark'
).preview;
const frontmatterColors = {
  key: '#e5c07b',
  value: '#d4d4d4',
  pillBackground: '#474b50'
};
const rendered = await exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'export-theme-fidelity',
    text: [
      '---',
      'title: Demo',
      'tags: [one, two]',
      '---',
      '',
      '```ts',
      code,
      '```'
    ].join('\n'),
    appearance: 'dark',
    uiLanguage: 'en',
    codeTheme,
    environment: {
      previewFontFamily: '',
      editorBackgroundColor: '#1e1e1e',
      editorForegroundColor: '#d4d4d4',
      codeBlockBackgroundColor: '#1e1e1e',
      sideBarBackgroundColor: '#252526',
      panelBorderColor: '#454545',
      previewSourceColoring: true,
      previewCodePalettes: { light: palette, dark: palette },
      frontmatterKeyColor: frontmatterColors.key,
      frontmatterValueColor: frontmatterColors.value,
      frontmatterPillBackgroundColor: frontmatterColors.pillBackground
    }
  },
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html',
  mermaidRuntimeSrc: '',
  baseHref: 'file:///C:/tmp/',
  title: 'Export theme fidelity'
});
const lightRenderedSnapshot = {
  snapshotId: 'export-theme-fidelity-light',
  text: [
    '---',
    'title: Demo',
    'tags: [one, two]',
    '---',
    '',
    '```ts',
    code,
    '```'
  ].join('\n'),
  appearance: 'light' as const,
  uiLanguage: 'en' as const,
  codeTheme,
  environment: {
    previewFontFamily: '',
    editorBackgroundColor: '#1e1e1e',
    editorForegroundColor: '#d4d4d4',
    codeBlockBackgroundColor: '#1e1e1e',
    sideBarBackgroundColor: '#252526',
    panelBorderColor: '#454545',
    previewSourceColoring: true,
    previewCodePalettes: { light: palette, dark: palette },
    frontmatterKeyColor: frontmatterColors.key,
    frontmatterValueColor: frontmatterColors.value,
    frontmatterPillBackgroundColor: frontmatterColors.pillBackground
  }
};
const lightRendered = await exportRuntime.renderExportHtmlDocument({
  readingSnapshot: lightRenderedSnapshot,
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export-light.html',
  target: 'html',
  mermaidRuntimeSrc: '',
  baseHref: 'file:///C:/tmp/',
  title: 'Light export theme fidelity'
});

const toRgb = (value: string | undefined): string => {
  if (!value) return '';
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return value.toLowerCase();
  const hex = match[1]!;
  return `rgb(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(hex.slice(2, 4), 16)}, ${Number.parseInt(hex.slice(4, 6), 16)})`;
};
const expectedTokens = await codeToTokens(code, { lang: 'ts', theme: darkPlus });
const expectedLines = expectedTokens.tokens.map((line) => line.flatMap((token) => (
  [...token.content].map((char) => ({ char, color: toRgb(token.color) }))
)));

const browser = await launchTestBrowser();
const tableOfContentsTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meo-export-toc-'));
try {
  const page = await browser.newPage();
  await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-meo-export-target', 'pdf');
    document.body.setAttribute('data-meo-export-target', 'pdf');
  });
  const actual = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-code-line-source')).map((line) => {
      const chars: Array<{ char: string; color: string }> = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const color = getComputedStyle(node.parentElement ?? line).color;
        for (const char of [...(node.textContent ?? '')]) chars.push({ char, color });
      }
      return chars;
    });
    const color = (selector: string, property: 'color' | 'backgroundColor' = 'color') => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? getComputedStyle(element)[property] : `missing:${selector}`;
    };
    return {
      lines,
      frontmatter: {
        key: color('.meo-export-frontmatter-key'),
        value: color('.meo-export-frontmatter-value'),
        pillBackground: color('.meo-export-frontmatter-pill', 'backgroundColor'),
        containerPaddingLeft: getComputedStyle(
          document.querySelector<HTMLElement>('.meo-export-frontmatter')!
        ).paddingLeft,
        rowBorderTopWidth: getComputedStyle(
          document.querySelector<HTMLElement>('.meo-export-frontmatter-line')!
        ).borderTopWidth,
        keyBorderRightWidth: getComputedStyle(
          document.querySelector<HTMLElement>('.meo-export-frontmatter-key-cell')!
        ).borderRightWidth,
        keyColumnWidth: document.querySelector<HTMLElement>('.meo-export-frontmatter-key-cell')!
          .getBoundingClientRect().width
      }
    };
  });

  const mismatches: Array<{ line: number; column: number; char: string; expected: string; actual: string }> = [];
  const ignoredCharacters = new Set([' ', '\t', '(', ')', '[', ']', '{', '}']);
  for (let lineIndex = 0; lineIndex < expectedLines.length; lineIndex += 1) {
    const expectedLine = expectedLines[lineIndex] ?? [];
    const actualLine = actual.lines[lineIndex] ?? [];
    for (let column = 0; column < expectedLine.length; column += 1) {
      const expectedChar = expectedLine[column]!;
      const actualChar = actualLine[column];
      if (ignoredCharacters.has(expectedChar.char)) continue;
      if (actualChar?.char !== expectedChar.char || actualChar.color !== expectedChar.color) {
        mismatches.push({
          line: lineIndex + 1,
          column: column + 1,
          char: expectedChar.char,
          expected: expectedChar.color,
          actual: actualChar?.color ?? '<missing>'
        });
      }
    }
  }

  const expectedFrontmatter = {
    key: toRgb(frontmatterColors.key),
    value: toRgb(frontmatterColors.value),
    pillBackground: toRgb(frontmatterColors.pillBackground),
    containerPaddingLeft: '0px',
    rowBorderTopWidth: '1px',
    keyBorderRightWidth: '1px',
    keyColumnWidth: 124
  };
  if (mismatches.length > 0 || JSON.stringify(actual.frontmatter) !== JSON.stringify(expectedFrontmatter)) {
    throw new Error(`Export theme differs from Live/Preview: ${JSON.stringify({
      mismatchCount: mismatches.length,
      firstMismatches: mismatches.slice(0, 12),
      expectedFrontmatter,
      actualFrontmatter: actual.frontmatter
    })}`);
  }

  await page.setContent(lightRendered.htmlDocument, { waitUntil: 'domcontentloaded' });
  const lightFrontmatterContrast = await page.evaluate(() => {
    const rgb = (value: string): [number, number, number] => {
      const components = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      return [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0];
    };
    const luminance = (value: string): number => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const ratio = (foreground: string, background: string): number => {
      const brighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (brighter + 0.05) / (darker + 0.05);
    };
    const background = getComputedStyle(document.body).backgroundColor;
    const key = getComputedStyle(document.querySelector<HTMLElement>('.meo-export-frontmatter-key')!).color;
    const value = getComputedStyle(document.querySelector<HTMLElement>('.meo-export-frontmatter-value')!).color;
    return {
      key,
      value,
      background,
      keyRatio: ratio(key, background),
      valueRatio: ratio(value, background)
    };
  });
  if (lightFrontmatterContrast.keyRatio < 4.5 || lightFrontmatterContrast.valueRatio < 4.5) {
    throw new Error(`Light Front Matter colors are unreadable: ${JSON.stringify(lightFrontmatterContrast)}`);
  }

  const tableOfContentsPath = path.join(tableOfContentsTempDir, 'with contents.html');
  const tableOfContentsRendered = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: {
      ...lightRenderedSnapshot,
      snapshotId: 'export-table-of-contents-navigation',
      text: '# Intro\n\n' + Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n') + '\n\n## Target heading'
    },
    sourceDocumentPath: path.join(tableOfContentsTempDir, 'source.md'),
    outputFilePath: tableOfContentsPath,
    target: 'html',
    mermaidRuntimeSrc: '',
    baseHref: pathToFileURL(`${tableOfContentsTempDir}${path.sep}`).href,
    title: 'Table of contents navigation',
    includeTableOfContents: true
  });
  await fs.promises.writeFile(tableOfContentsPath, tableOfContentsRendered.htmlDocument, 'utf8');
  await page.goto(pathToFileURL(tableOfContentsPath).href, { waitUntil: 'domcontentloaded' });
  const initialNavigation = await page.evaluate(() => ({
    pathname: location.pathname,
    targetTop: document.querySelector<HTMLElement>('#target-heading')!.getBoundingClientRect().top
  }));
  await page.click('a[href$="#target-heading"]');
  await page.waitForFunction(() => location.hash === '#target-heading');
  const navigation = await page.evaluate(() => ({
    pathname: location.pathname,
    hash: location.hash,
    targetTop: document.querySelector<HTMLElement>('#target-heading')!.getBoundingClientRect().top
  }));
  if (
    navigation.pathname !== initialNavigation.pathname
    || navigation.hash !== '#target-heading'
    || navigation.targetTop >= initialNavigation.targetTop
  ) {
    throw new Error(`HTML contents link did not stay in-document: ${JSON.stringify({ initialNavigation, navigation })}`);
  }

  console.log('Export theme fidelity checks passed');
} finally {
  await browser.close();
  await fs.promises.rm(tableOfContentsTempDir, { recursive: true, force: false });
}
