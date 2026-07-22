import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const legacyNamespace = 'markdownEditor' + 'Optimized';

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectTypeScriptFiles(fullPath)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [fullPath]
        : [];
  });
}

const runtimeFiles = [
  path.join(repoRoot, 'package.json'),
  ...collectTypeScriptFiles(path.join(repoRoot, 'src'))
];
const offenders = runtimeFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(legacyNamespace));

if (offenders.length > 0) {
  throw new Error(`Legacy extension namespace remains in runtime files: ${offenders.map((file) => path.relative(repoRoot, file)).join(', ')}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const launchJson = JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode', 'launch.json'), 'utf8'));
const expectedPrefix = 'meoEnhanced.';
const privateIds = [
  ...packageJson.contributes.commands.map((entry: { command: string }) => entry.command),
  ...packageJson.contributes.customEditors.map((entry: { viewType: string }) => entry.viewType),
  ...Object.keys(packageJson.contributes.configuration.properties)
];
const invalidIds = privateIds.filter((id) => !id.startsWith(expectedPrefix));

if (invalidIds.length > 0) {
  throw new Error(`Extension-private IDs are outside ${expectedPrefix}: ${invalidIds.join(', ')}`);
}

const runConfiguration = launchJson.configurations.find((configuration: { name: string }) => configuration.name === 'Run');
if (!runConfiguration?.args?.includes('--disable-extension=vadimmelnicuk.meo')) {
  throw new Error('F5 must disable the installed original MEO extension so restored legacy editor tabs cannot mask development changes');
}

console.log('extension namespace checks passed');
