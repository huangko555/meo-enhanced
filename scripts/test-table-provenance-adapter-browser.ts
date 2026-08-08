import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-provenance-adapter-'));

async function main(): Promise<void> {
  const entry = path.join(repoRoot, 'scripts', 'test-table-provenance-adapter-entry.ts');
  const entrySource = fs.readFileSync(entry, 'utf8');
  assert.equal(/webview\/src\/(?:editor|index)/.test(entrySource), false);
  assert.equal(entrySource.includes('tableRowDiffProvenance'), false);

  const build = await Bun.build({
    entrypoints: [entry], outdir: tempDir, target: 'browser', format: 'iife', naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="insert-row">insert</button><button id="delete-row">delete</button><div id="app"></div>');
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
    const original = ['| A |', '| --- |', '| same |', '', '| B |', '| --- |', '| same |'].join('\n');
    await page.evaluate((text) => (window as any).__tableProvenanceCandidate.initialize(text), original);

    await page.click('#insert-row');
    let snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.moduleStarts, 1);
    assert.equal(snapshot.adapterStarts, 1);
    assert.equal(snapshot.legacyStarts, 0);
    assert.deepEqual(snapshot.provenance.insertedRows, [{ id: 'row-1', from: 23, to: 31 }]);

    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.undo()), true);
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.deepEqual(snapshot.provenance.insertedRows, []);
    assert.equal(snapshot.text, original);

    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.redo()), true);
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.deepEqual(snapshot.provenance.insertedRows, [{ id: 'row-1', from: 23, to: 31 }]);

    // Arbitrary edits map existing identities without interpreting row text.
    await page.evaluate(() => (window as any).__tableProvenanceCandidate.edit(0, 0, 'x\n'));
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.deepEqual(snapshot.provenance.insertedRows, [{ id: 'row-1', from: 25, to: 33 }]);

    // Toolbar deletion records independent identities even for equivalent rows.
    await page.click('#delete-row');
    await page.evaluate(() => (window as any).__tableProvenanceCandidate.deleteRows(4, 4, [[4, 4]], false));
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.deletedRows.length, 2);
    assert.notEqual(snapshot.provenance.deletedRows[0].id, snapshot.provenance.deletedRows[1].id);
    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.undo()), true);
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.deletedRows.length, 1);
    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.undo()), true);
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.deletedRows.length, 0);
    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.redo()), true);
    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceCandidate.redo()), true);
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.deletedRows.length, 2);

    // Baseline refresh invalidates the scope. A previously captured effect cannot revive it.
    await page.evaluate(() => {
      const candidate = (window as any).__tableProvenanceCandidate;
      candidate.captureLateInsertedEffect(2);
      candidate.baselineRefreshed();
      candidate.dispatchLateEffect();
    });
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.scope, 1);
    assert.deepEqual(snapshot.provenance.insertedRows, []);
    assert.deepEqual(snapshot.provenance.deletedRows, []);

    // Remapping uses stable identities across an ambiguous table serialization.
    await page.evaluate(() => {
      const candidate = (window as any).__tableProvenanceCandidate;
      candidate.insertRow(2, '| alpha |');
      candidate.insertRow(3, '| beta |');
      candidate.insertRow(candidate.snapshot().text.split('\n').length, '| other table |');
    });
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    const rows = snapshot.provenance.insertedRows;
    assert.equal(rows.length, 3);
    const otherTableRow = rows[2];
    await page.evaluate((ids) => {
      const candidate = (window as any).__tableProvenanceCandidate;
      candidate.remapTable(2, 4, '| alpha |\n| joined |\n| beta |', [
        { id: ids[0], oldOffset: 0, newOffset: 0 },
        { id: ids[1], oldOffset: 10, newOffset: 21 }
      ]);
    }, rows.map((row: any) => row.id));
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.deepEqual(snapshot.provenance.insertedRows.map((row: any) => row.id), rows.map((row: any) => row.id));
    assert.equal(snapshot.provenance.insertedRows.length, 3);
    assert.equal(
      snapshot.provenance.insertedRows.find((row: any) => row.id === otherTableRow.id).to
        - snapshot.provenance.insertedRows.find((row: any) => row.id === otherTableRow.id).from,
      otherTableRow.to - otherTableRow.from,
      'remapping one table must not reinterpret an identity from another table'
    );

    // External presentation is deliberately a stronger invalidation boundary than Legacy.
    await page.evaluate(() => (window as any).__tableProvenanceCandidate.externalDocumentPresented());
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.scope, 2);
    assert.deepEqual(snapshot.provenance.insertedRows, []);

    await page.evaluate(() => {
      const candidate = (window as any).__tableProvenanceCandidate;
      candidate.captureLateInsertedEffect(2);
      candidate.disposeAdapter();
      candidate.dispatchLateEffect();
    });
    snapshot = await page.evaluate(() => (window as any).__tableProvenanceCandidate.snapshot());
    assert.equal(snapshot.provenance.lifecycle, 'disposed');
    assert.deepEqual(snapshot.provenance.insertedRows, []);

    await page.evaluate(() => (window as any).__tableProvenanceCandidate.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('CodeMirror table provenance Adapter candidate trace passed');
}

await main();
