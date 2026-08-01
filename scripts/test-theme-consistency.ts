import fs from 'node:fs';
import path from 'node:path';
import { defaultThemeSettings, semanticColorKeys, themePresets } from '../src/shared/themeDefaults';
import { parseThemeJsonc } from '../src/shared/themeJsonc';

const repoRoot = path.resolve(import.meta.dir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const themeSchema = packageJson.contributes.configuration.properties['meoEnhanced.theme'];
const schemaSemanticProperties = themeSchema.properties.semanticColors.properties;
const packageDefaultSemanticColors = themeSchema.default.semanticColors;
const snippetTheme = JSON.parse(themeSchema.defaultSnippets[0].body);
const fileTheme = parseThemeJsonc(fs.readFileSync(path.join(repoRoot, 'themes', 'hkk-theme.jsonc'), 'utf8')) as any;
const fontSchemaProperties = themeSchema.properties.fonts.properties;
const packageDefaultFonts = themeSchema.default.fonts;

const failures: string[] = [];
if (defaultThemeSettings.semanticColors.codeBlockBackground !== '#1b1f23') {
  failures.push(
    `HKK block background is ${defaultThemeSettings.semanticColors.codeBlockBackground}`
  );
}
for (const key of semanticColorKeys) {
  if (!(key in schemaSemanticProperties)) failures.push(`schema is missing semanticColors.${key}`);
  if (!(key in packageDefaultSemanticColors)) failures.push(`package default is missing semanticColors.${key}`);
  if (!(key in snippetTheme.semanticColors)) failures.push(`default snippet is missing semanticColors.${key}`);
  if (!(key in fileTheme.semanticColors)) failures.push(`hkk-theme.jsonc is missing semanticColors.${key}`);
  const expected = defaultThemeSettings.semanticColors[key];
  if (packageDefaultSemanticColors[key] !== expected) {
    failures.push(`package default semanticColors.${key} differs: ${packageDefaultSemanticColors[key]} !== ${expected}`);
  }
  if (snippetTheme.semanticColors[key] !== expected) {
    failures.push(`default snippet semanticColors.${key} differs: ${snippetTheme.semanticColors[key]} !== ${expected}`);
  }
  if (fileTheme.semanticColors[key] !== expected) {
    failures.push(`hkk-theme.jsonc semanticColors.${key} differs: ${fileTheme.semanticColors[key]} !== ${expected}`);
  }
}

for (const key of Object.keys(defaultThemeSettings.fonts) as Array<keyof typeof defaultThemeSettings.fonts>) {
  const expected = defaultThemeSettings.fonts[key];
  if (packageDefaultFonts[key] !== expected) {
    failures.push(`package default fonts.${key} differs: ${packageDefaultFonts[key]} !== ${expected}`);
  }
  if (snippetTheme.fonts[key] !== expected) {
    failures.push(`default snippet fonts.${key} differs: ${snippetTheme.fonts[key]} !== ${expected}`);
  }
  if (fileTheme.fonts[key] !== expected) {
    failures.push(`hkk-theme.jsonc fonts.${key} differs: ${fileTheme.fonts[key]} !== ${expected}`);
  }
  if (fontSchemaProperties[key]?.default !== expected) {
    failures.push(`schema default fonts.${key} differs: ${fontSchemaProperties[key]?.default} !== ${expected}`);
  }
}

const githubLight = themePresets.find((theme) => theme.id === 'github-light');
if (!githubLight) {
  failures.push('GitHub Light preset is missing');
} else {
  if (githubLight.semanticColors.codeBlockBackground !== '#f6f8fa') {
    failures.push(`GitHub Light code block background is ${githubLight.semanticColors.codeBlockBackground}`);
  }
  if (githubLight.semanticColors.inlineCodeBackground !== '#eff1f3') {
    failures.push(`GitHub Light inline code background is ${githubLight.semanticColors.inlineCodeBackground}`);
  }
  if (githubLight.semanticColors.headingForeground !== '#0969da') {
    failures.push(`GitHub Light heading foreground is ${githubLight.semanticColors.headingForeground}`);
  }
}

for (const theme of themePresets) {
  if (theme.semanticColors.codeLanguageLabelForeground !== theme.semanticColors.mutedForeground) {
    failures.push(
      `${theme.name} code language label is not neutral: ` +
      `${theme.semanticColors.codeLanguageLabelForeground} !== ${theme.semanticColors.mutedForeground}`
    );
  }
}

if (failures.length) {
  throw new Error(failures.join('\n'));
}

console.log('theme runtime, file, defaults, snippet, and schema are consistent');
