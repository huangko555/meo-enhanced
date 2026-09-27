import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-native-seed-'));
const documentUri = 'file:///fixture.md';
try {
  for (const [index, scenario] of [
    { top: 0, height: 3000, position: null, passed: false, coverage: 'non-top' },
    { top: 0, height: 3000, position: { line: 40, lineOffset: 0 }, passed: false, coverage: 'non-top' },
    { top: 800, height: 3000, position: null, passed: false, coverage: 'non-top' },
    { top: 800, height: 3000, position: { line: 1, lineOffset: 0 }, passed: false, coverage: 'non-top' },
    { top: 20, height: 530, position: { line: 2, lineOffset: 0 }, passed: true, coverage: 'non-top' },
    { top: 800, height: 3000, position: { line: 40, lineOffset: 0 }, passed: true, coverage: 'non-top' },
    { top: 0, height: 500, position: null, passed: true, coverage: 'not-scrollable' }
  ].entries()) {
    const output = path.join(temporary, String(index));
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'seed.json'), JSON.stringify({
      documentUri, seedPosition: { scrollTop: scenario.top, scrollHeight: scenario.height, clientHeight: 500 }
    }));
    const database = new Database(path.join(output, 'seed-state-workspace.vscdb'));
    database.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    database.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'huangko555.meo-enhanced', JSON.stringify({
        'readingPositionsByDocument.v2': scenario.position ? { [documentUri]: scenario.position } : {}
      })
    );
    database.close();
    const child = Bun.spawnSync([
      process.execPath, path.join(import.meta.dir, 'benchmark-vscode-seed-state.ts'), output
    ], { stdout: 'pipe', stderr: 'pipe' });
    assert.equal(child.exitCode === 0, scenario.passed, `${index}: ${child.stderr.toString()}`);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'seed.json'), 'utf8'));
    assert.equal(report.seedMemoryValid, scenario.passed);
    assert.equal(report.restorationCoverage, scenario.coverage);
    assert.equal(report.minimumRestoreScrollTop, Math.min(100, (scenario.height - 500) / 4));
  }
  console.log('Native mode seed persistence prerequisites passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}