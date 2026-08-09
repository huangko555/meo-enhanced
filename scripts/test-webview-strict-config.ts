import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const webviewConfigPath = resolve(import.meta.dir, '../webview/tsconfig.json');
const retiredIslandsConfigPath = resolve(import.meta.dir, '../webview/tsconfig.strict-islands.json');
const packagePath = resolve(import.meta.dir, '../package.json');

const webviewConfig = JSON.parse(readFileSync(webviewConfigPath, 'utf8')) as {
  compilerOptions?: Record<string, unknown>;
};
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  scripts?: Record<string, string>;
};

if (webviewConfig.compilerOptions?.strict !== true) {
  throw new Error('The main Webview TypeScript config must enable strict mode');
}
if (existsSync(retiredIslandsConfigPath)) {
  throw new Error('The retired Webview strict-islands config must not return');
}
if (Object.keys(packageJson.scripts ?? {}).some((name) => name.includes('strict-islands'))) {
  throw new Error('The retired Webview strict-islands package script must not return');
}

console.log('Webview strict TypeScript config contract passed');
