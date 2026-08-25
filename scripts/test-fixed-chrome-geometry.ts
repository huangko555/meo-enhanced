import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  fixedChromeAffineMappingFromSamples,
  projectFixedChromeGeometry,
  type FixedChromeAffineMapping,
  type FixedChromeGeometry
} from '../webview/src/editor/fixedChromeGeometry';

const root = path.resolve(import.meta.dir, '..');
const samplerPath = path.join(
  root,
  'webview',
  'src',
  'editor',
  'internal',
  'fixedChromeDomGeometry.ts'
);
const callerSources = [
  path.join(root, 'webview', 'src', 'helpers', 'tables.ts'),
  path.join(root, 'webview', 'src', 'editor', 'internal', 'codeMirrorDomTableStickyHeaderAdapter.ts')
].map((file) => fs.readFileSync(file, 'utf8'));
const samplerSource = fs.existsSync(samplerPath) ? fs.readFileSync(samplerPath, 'utf8') : '';
const probeImplementation = 'position:fixed;inset:auto;left:';
assert.equal(
  callerSources.reduce((count, source) => count + source.split(probeImplementation).length - 1, 0),
  0,
  'Toolbar and Sticky callers must not duplicate fixed containing-block DOM probes'
);
assert.equal(
  samplerSource.split(probeImplementation).length - 1,
  1,
  'the editor-owned DOM sampler must be the unique fixed containing-block probe implementation'
);
for (const source of callerSources) {
  assert.match(source, /fixedChromeDomGeometry/, 'both callers must use the shared DOM sampler');
}

assert.deepEqual(fixedChromeAffineMappingFromSamples(
  { x: 40, y: 12 },
  { x: 165, y: 12 },
  { x: 40, y: 87 },
  100
), { a: 1.25, b: 0, c: 0, d: 0.75, e: 40, f: 12 });

const geometry: FixedChromeGeometry = {
  rect: { left: 66.25, top: 52.5, width: 500, height: 43.75 },
  vectors: [
    { x: 625, y: 0 },
    { x: -52.5, y: 0 },
    { x: 0, y: 40 }
  ]
};

function assertGeometryClose(actual: FixedChromeGeometry, expected: FixedChromeGeometry, name: string): void {
  const close = (left: number, right: number, label: string) => {
    assert.ok(Math.abs(left - right) <= 1e-9, `${name} ${label}: ${left} != ${right}`);
  };
  close(actual.rect.left, expected.rect.left, 'left');
  close(actual.rect.top, expected.rect.top, 'top');
  close(actual.rect.width, expected.rect.width, 'width');
  close(actual.rect.height, expected.rect.height, 'height');
  assert.equal(actual.vectors.length, expected.vectors.length, `${name} vector count`);
  actual.vectors.forEach((vector, index) => {
    close(vector.x, expected.vectors[index].x, `vector ${index} x`);
    close(vector.y, expected.vectors[index].y, `vector ${index} y`);
  });
}

const cases: ReadonlyArray<{
  readonly name: string;
  readonly mapping: FixedChromeAffineMapping;
  readonly expected: FixedChromeGeometry;
}> = [
  {
    name: 'identity',
    mapping: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    expected: geometry
  },
  {
    name: 'zoom 0.8',
    mapping: { a: 0.8, b: 0, c: 0, d: 0.8, e: 10, f: 6 },
    expected: {
      rect: { left: 70.3125, top: 58.125, width: 625, height: 54.6875 },
      vectors: [{ x: 781.25, y: 0 }, { x: -65.625, y: 0 }, { x: 0, y: 50 }]
    }
  },
  {
    name: 'zoom 1',
    mapping: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 6 },
    expected: {
      rect: { left: 56.25, top: 46.5, width: 500, height: 43.75 },
      vectors: [{ x: 625, y: 0 }, { x: -52.5, y: 0 }, { x: 0, y: 40 }]
    }
  },
  {
    name: 'zoom 1.25',
    mapping: { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 },
    expected: {
      rect: { left: 53, top: 42, width: 400, height: 35 },
      vectors: [{ x: 500, y: 0 }, { x: -42, y: 0 }, { x: 0, y: 32 }]
    }
  },
  {
    name: 'nested scale and translate',
    mapping: { a: 1.5, b: 0, c: 0, d: 0.75, e: -24, f: 15 },
    expected: {
      rect: { left: 60.166666666666664, top: 50, width: 333.3333333333333, height: 58.333333333333336 },
      vectors: [{ x: 416.6666666666667, y: 0 }, { x: -35, y: 0 }, { x: 0, y: 53.333333333333336 }]
    }
  }
];

for (const testCase of cases) {
  const result = projectFixedChromeGeometry(testCase.mapping, geometry);
  assert.equal(result.ok, true, testCase.name);
  if (result.ok) assertGeometryClose(result.geometry, testCase.expected, testCase.name);
}

const failures: ReadonlyArray<{
  readonly name: string;
  readonly mapping: FixedChromeAffineMapping;
  readonly expected: string;
}> = [
  {
    name: 'negative scale',
    mapping: { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    expected: 'negative-scale'
  },
  {
    name: 'non-finite',
    mapping: { a: Number.POSITIVE_INFINITY, b: 0, c: 0, d: 1, e: 0, f: 0 },
    expected: 'non-finite'
  },
  {
    name: 'singular',
    mapping: { a: 0, b: 0, c: 0, d: 1, e: 0, f: 0 },
    expected: 'singular'
  },
  {
    name: 'rotated',
    mapping: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },
    expected: 'non-axis-aligned'
  },
  {
    name: 'skewed',
    mapping: { a: 1, b: 0.2, c: 0, d: 1, e: 0, f: 0 },
    expected: 'non-axis-aligned'
  }
];

for (const testCase of failures) {
  assert.deepEqual(projectFixedChromeGeometry(testCase.mapping, geometry), {
    ok: false,
    reason: testCase.expected
  }, testCase.name);
}

assert.deepEqual(projectFixedChromeGeometry(
  { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  { rect: { left: 0, top: 0, width: -1, height: 10 }, vectors: [] }
), { ok: false, reason: 'invalid-geometry' });
assert.deepEqual(projectFixedChromeGeometry(
  { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  { rect: { left: 0, top: 0, width: 10, height: 10 }, vectors: [{ x: Number.NaN, y: 0 }] }
), { ok: false, reason: 'non-finite' });

const localWorkedExample: FixedChromeGeometry = {
  rect: { left: 21, top: 42, width: 400, height: 35 },
  vectors: [{ x: 500, y: 0 }, { x: -42, y: 0 }, { x: 0, y: 32 }]
};
const localToViewport = { a: 1.25, b: 0, c: 0, d: 1.25, e: 40, f: 0 } as const;
const viewportWorkedExample: FixedChromeGeometry = {
  rect: { left: 66.25, top: 52.5, width: 500, height: 43.75 },
  vectors: [{ x: 625, y: 0 }, { x: -52.5, y: 0 }, { x: 0, y: 40 }]
};
const projected = projectFixedChromeGeometry(localToViewport, viewportWorkedExample);
assert.equal(projected.ok, true);
if (projected.ok) assertGeometryClose(projected.geometry, localWorkedExample, 'worked example');
const roundTrip = projectFixedChromeGeometry(
  { a: 0.8, b: 0, c: 0, d: 0.8, e: -32, f: 0 },
  localWorkedExample
);
assert.equal(roundTrip.ok, true);
if (roundTrip.ok) {
  assert.ok(Math.abs(roundTrip.geometry.rect.left - viewportWorkedExample.rect.left) <= 1);
  assert.ok(Math.abs(roundTrip.geometry.rect.top - viewportWorkedExample.rect.top) <= 1);
  assert.ok(Math.abs(roundTrip.geometry.rect.width - viewportWorkedExample.rect.width) <= 1);
  assert.ok(Math.abs(roundTrip.geometry.rect.height - viewportWorkedExample.rect.height) <= 1);
  assert.ok(Math.abs(roundTrip.geometry.vectors[1].x - viewportWorkedExample.vectors[1].x) <= 1);
}

console.log('fixed chrome geometry contracts passed');
