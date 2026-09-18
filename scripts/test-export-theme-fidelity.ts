import darkPlus from '@shikijs/themes/dark-plus';
import { codeToTokens } from 'shiki';
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
try {
  const page = await browser.newPage();
  await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
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
        pillBackground: color('.meo-export-frontmatter-pill', 'backgroundColor')
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
    pillBackground: toRgb(frontmatterColors.pillBackground)
  };
  if (mismatches.length > 0 || JSON.stringify(actual.frontmatter) !== JSON.stringify(expectedFrontmatter)) {
    throw new Error(`Export theme differs from Live/Preview: ${JSON.stringify({
      mismatchCount: mismatches.length,
      firstMismatches: mismatches.slice(0, 12),
      expectedFrontmatter,
      actualFrontmatter: actual.frontmatter
    })}`);
  }

  console.log('Export theme fidelity checks passed');
} finally {
  await browser.close();
}
