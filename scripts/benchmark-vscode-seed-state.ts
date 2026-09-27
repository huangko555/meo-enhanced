import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

// Inspect only the launcher's copied, isolated databases after VS Code exits.
// A scrolled DOM alone does not establish the prerequisite for restart restore.
const output = path.resolve(process.argv[2]);
const seedPath = path.join(output, 'seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
assert.equal(typeof seed.documentUri, 'string');
let position: { line: number; lineOffset: number } | null = null;
for (const file of fs.readdirSync(output).filter(file => (
  file.startsWith('seed-state-') && file.endsWith('.vscdb')
))) {
  const database = new Database(path.join(output, file), { readonly: true });
  try {
    const row = database.query(
      "SELECT value FROM ItemTable WHERE key = 'huangko555.meo-enhanced'"
    ).get() as { value: string | Uint8Array } | null;
    if (!row) continue;
    const state = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
    position = state['readingPositionsByDocument.v2']?.[seed.documentUri] ?? position;
  } finally {
    database.close();
  }
}
seed.persistedPosition = position;
const scrollRange = Math.max(0, seed.seedPosition.scrollHeight - seed.seedPosition.clientHeight);
assert.ok(Number.isFinite(scrollRange), 'Missing seed scroll geometry');
seed.restorationCoverage = scrollRange > 1 ? 'non-top' : 'not-scrollable';
seed.minimumRestoreScrollTop = Math.min(100, scrollRange / 4);
seed.seedMemoryValid = seed.restorationCoverage === 'not-scrollable'
  || (seed.seedPosition.scrollTop > seed.minimumRestoreScrollTop
    && !!position && (position.line > 1 || position.lineOffset > 0));
fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2));
assert.ok(seed.seedMemoryValid,
  'Seed did not persist a non-top position; restart restoration was not tested');