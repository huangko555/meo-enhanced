import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const readRepoFile = (path: string): string =>
  readFileSync(resolve(repoRoot, path), 'utf8');

const guide = readRepoFile('CONTRIBUTING.md');
const packageJson = JSON.parse(readRepoFile('package.json')) as {
  engines?: { vscode?: string };
  scripts?: Record<string, string>;
};
const architectureBaseline = JSON.parse(
  readRepoFile('scripts/architecture-baseline.json')
) as {
  knownLegacyTestFailures?: Array<{
    id: string;
    test: string;
    fingerprint: string;
  }>;
};

for (const readme of ['README.md', 'README.zh-CN.md']) {
  if (!/href=["'](?:\.\/)?CONTRIBUTING\.md["']/.test(readRepoFile(readme))) {
    throw new Error(`${readme} must link to CONTRIBUTING.md`);
  }
}

const scripts = packageJson.scripts ?? {};
const documentedScripts = [
  ...guide.matchAll(/\bbun run ([a-z0-9:-]+)\b/g)
].map((match) => match[1]);
for (const script of new Set(documentedScripts)) {
  if (!(script in scripts)) {
    throw new Error(`CONTRIBUTING.md references missing package script ${script}`);
  }
}

if (!guide.includes('bun install --frozen-lockfile')) {
  throw new Error('CONTRIBUTING.md must document the frozen-lockfile install');
}
const vscodeRange = packageJson.engines?.vscode;
if (!vscodeRange || !guide.includes(`VS Code \`${vscodeRange}\``)) {
  throw new Error('CONTRIBUTING.md must match the declared VS Code engine range');
}

const frozenFailure = architectureBaseline.knownLegacyTestFailures?.find(
  ({ id }) => id === 'LEG-TEST-001'
);
if (
  !frozenFailure ||
  !guide.includes(frozenFailure.id) ||
  !guide.includes(frozenFailure.test) ||
  !guide.includes(frozenFailure.fingerprint)
) {
  throw new Error('CONTRIBUTING.md must identify the exact frozen legacy failure');
}

const forbiddenPrivatePaths = [
  /\.local[\\/]/,
  /(?:^|[\s`"'(])[A-Za-z]:[\\/]/m,
  /(?:^|[\s`])\/Users\//m,
  /(?:^|[\s`])\/home\//m,
  /\\Users\\/
];
if (forbiddenPrivatePaths.some((pattern) => pattern.test(guide))) {
  throw new Error('CONTRIBUTING.md must not expose private or machine-local paths');
}

console.log('Contributing guide contract passed');
