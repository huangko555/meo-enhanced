import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

const configurationHandlerStart = extensionSource.indexOf('async handleConfigurationChanged(');
const configurationHandlerEnd = extensionSource.indexOf('\n  notifyThemeChanged()', configurationHandlerStart);
if (configurationHandlerStart < 0 || configurationHandlerEnd < 0) {
  throw new Error('Could not locate the configuration-change handler');
}

const configurationHandler = extensionSource.slice(configurationHandlerStart, configurationHandlerEnd);
const sessionSettingBroadcasts = [
  'lineNumbersChanged',
  'gitChangesGutterChanged',
  'gitBlameChanged',
  'gitDiffLineHighlightsChanged',
  'diffBaselineModeChanged',
  'contentMaxWidthChanged',
  'longCodeBlockFoldingChanged',
  'spellCheckChanged',
  'outlinePositionChanged',
  'outlineVisibilityChanged'
];

const leakedBroadcasts = sessionSettingBroadcasts.filter((messageType) => configurationHandler.includes(messageType));
if (leakedBroadcasts.length > 0) {
  throw new Error(`Persisted editor settings still broadcast to open sessions: ${leakedBroadcasts.join(', ')}`);
}

for (const methodName of ['setFindOptions', 'setPreviewAppearance', 'setOutlineVisible']) {
  const methodStart = extensionSource.indexOf(`private async ${methodName}(`);
  const methodEnd = extensionSource.indexOf('\n  private ', methodStart + 1);
  if (methodStart < 0 || methodEnd < 0) {
    throw new Error(`Could not locate ${methodName}`);
  }
  if (extensionSource.slice(methodStart, methodEnd).includes('this.broadcast(')) {
    throw new Error(`${methodName} still updates other open editor sessions`);
  }
}

console.log('session setting isolation checks passed');
