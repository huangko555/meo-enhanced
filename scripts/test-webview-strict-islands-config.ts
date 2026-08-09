import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(import.meta.dir, '../webview/tsconfig.strict-islands.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  extends?: unknown;
  compilerOptions?: Record<string, unknown>;
  files?: unknown;
  include?: unknown;
};
const expectedRoots = [
  'src/helpers/images.ts',
  'src/helpers/htmlContent.ts',
  'src/helpers/highlightSyntax.ts',
  'src/helpers/listMarkers.ts',
  'src/helpers/tags.ts',
  'src/helpers/theme.ts',
  'src/themes/editorLightTheme.ts'
];

if (config.extends !== './tsconfig.json') {
  throw new Error('Webview strict-islands config must extend the main Webview config');
}
if (config.compilerOptions?.strictNullChecks !== true || config.compilerOptions?.noImplicitAny !== true) {
  throw new Error('Webview strict-islands compiler options are incomplete');
}
if (JSON.stringify(config.files) !== JSON.stringify(expectedRoots)) {
  throw new Error(`Webview strict-islands roots changed: ${JSON.stringify(config.files)}`);
}
if (!Array.isArray(config.include) || config.include.length !== 0) {
  throw new Error('Webview strict-islands config must not inherit the main include set');
}

console.log('Webview strict-islands config contract passed');
