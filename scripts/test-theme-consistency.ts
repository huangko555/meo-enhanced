import fs from 'node:fs';
import path from 'node:path';
import { defaultThemeSettings, semanticColorKeys, themePresets } from '../src/shared/themeDefaults';
import { parseThemeJsonc } from '../src/shared/themeJsonc';

const repoRoot = path.resolve(import.meta.dir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const themeSchema = packageJson.contributes.configuration.properties['markdownEditorOptimized.theme'];
const schemaSemanticProperties = themeSchema.properties.semanticColors.properties;
const packageDefaultSemanticColors = themeSchema.default.semanticColors;
const snippetTheme = JSON.parse(themeSchema.defaultSnippets[0].body);
const fileTheme = parseThemeJsonc(fs.readFileSync(path.join(repoRoot, 'themes', 'hkk-theme.jsonc'), 'utf8')) as any;

const failures: string[] = [];
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

if (failures.length) {
  throw new Error(failures.join('\n'));
}

console.log('theme runtime, file, defaults, snippet, and schema are consistent');
