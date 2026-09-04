import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkflowStep = { run?: unknown; uses?: unknown };
type Workflow = {
  name?: string;
  on?: { pull_request?: unknown; push?: { branches?: string[]; tags?: string[] } };
  jobs?: Record<string, {
    'runs-on'?: string;
    strategy?: { 'fail-fast'?: boolean; matrix?: { os?: string[] } };
    steps?: WorkflowStep[];
  }>;
};

const repoRoot = resolve(import.meta.dir, '..');
const workflow = Bun.YAML.parse(
  readFileSync(resolve(repoRoot, '.github/workflows/architecture-gate.yml'), 'utf8')
) as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

if (workflow.name !== 'CI checks') {
  throw new Error('CI workflow name must describe all checks, not only architecture');
}
if (!workflow.on || !('pull_request' in workflow.on)
  || JSON.stringify(workflow.on.push?.branches) !== JSON.stringify(['**'])
  || workflow.on.push?.tags !== undefined) {
  throw new Error('CI must check pull requests and all branch pushes without duplicate tag runs');
}
const verify = workflow.jobs?.verify;
if (verify?.['runs-on'] !== '${{ matrix.os }}'
  || JSON.stringify(verify.strategy?.matrix?.os) !== JSON.stringify(['ubuntu-latest', 'windows-latest'])
  || verify.strategy?.['fail-fast'] !== false) {
  throw new Error('CI must independently check both Ubuntu and Windows');
}

const steps = workflow.jobs?.verify?.steps;
if (!Array.isArray(steps)) {
  throw new Error('Architecture gate must define the verify job steps');
}

const runCommands = steps
  .map((step) => step.run)
  .filter((command): command is string => typeof command === 'string');
const requiredCommands = [
  'bun install --frozen-lockfile',
  'bun run typecheck',
  'bun run architecture:check',
  'bun run test:unit',
  'bun run build',
  'bun run package:check'
];
for (const command of requiredCommands) {
  if (runCommands.filter((candidate) => candidate === command).length !== 1) {
    throw new Error(`Architecture gate must run exactly one ${command}`);
  }
}
if (runCommands.indexOf('bun run package:check') <= runCommands.indexOf('bun run build')) {
  throw new Error('Architecture gate must validate VSIX contents after building runtime artifacts');
}

const consolidatedUnitContracts = [
  'scripts/test-document-session.ts',
  'scripts/test-document-session-application.ts',
  'scripts/test-document-session-protocol.ts',
  'scripts/test-document-session-actions.ts',
  'scripts/test-document-session-production-cutover.ts',
  'scripts/test-protocol-ready-init.ts',
  'scripts/test-protocol-stale-responses.ts'
];
const testUnit = packageJson.scripts?.['test:unit'] ?? '';
for (const contract of consolidatedUnitContracts) {
  if (!testUnit.includes(`bun ${contract}`)) {
    throw new Error(`test:unit no longer contains ${contract}`);
  }
  if (runCommands.some((command) => command.includes(contract))) {
    throw new Error(`Architecture gate duplicates test:unit contract ${contract}`);
  }
}

const testBrowser = packageJson.scripts?.['test:browser'] ?? '';
if (!testBrowser.includes('bun scripts/test-history-matrix.ts')) {
  throw new Error('test:browser must include the production mixed history matrix');
}

console.log('Cross-platform CI gate contract passed');
