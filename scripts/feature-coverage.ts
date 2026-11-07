import { posix } from 'node:path';

export const featureCoveragePath = 'docs/testing-feature-coverage.md';
export function referencesTestPath(command: unknown, path: string): boolean {
  if (typeof command !== 'string') return false;
  return command.replaceAll('\\', '/').split(/[\s"'`()\[\],;=]+/)
    .some(reference => reference === path || reference === `./${path}`);
}
export type FeatureCoverageEntry = {
  section: string;
  label: string;
  expected: string;
  evidence: string;
  tests: string[];
  links: string[];
  publicIds: string[];
  line: number;
};

function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let start = 1;
  for (let index = 1; index < line.length; index++) {
    if (line[index] !== '|') continue;
    let escapes = 0;
    for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous--) escapes++;
    if (escapes % 2) continue;
    cells.push(line.slice(start, index).trim());
    start = index + 1;
  }
  if (line.slice(start).trim()) cells.push(line.slice(start).trim());
  return cells;
}

export function parseFeatureCoverage(text: string): FeatureCoverageEntry[] {
  const entries: FeatureCoverageEntry[] = [];
  const labels = new Set<string>();
  const lines = text.split(/\r?\n/);
  let section = '', columns = 0, fence = '';
  const fail = (line: number, reason: string): never => { throw new Error(`${featureCoveragePath}:${line}: ${reason}`); };
  for (let index = 0; index < lines.length; index++) {
    const source = lines[index].trim();
    const fenceMarker = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
    if (fenceMarker) {
      if (!fence) fence = fenceMarker;
      else if (fenceMarker[0] === fence[0] && fenceMarker.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const heading = /^##\s+(.+)$/.exec(source);
    if (heading) { section = heading[1].trim(); columns = 0; continue; }
    if (!source.startsWith('|')) { columns = 0; continue; }
    const cells = cellsOf(source);
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const next = lines[index + 1]?.trim();
    if (next?.startsWith('|') && cellsOf(next).every(cell => /^:?-{3,}:?$/.test(cell))) {
      if (!section || ![2, 3].includes(cells.length)) fail(index + 1, 'Expected a section and a two- or three-column capability table');
      columns = cells.length;
      continue;
    }
    if (!columns || cells.length !== columns || cells.some(cell => !cell)) {
      fail(index + 1, 'Malformed capability row; preserve its table columns and nonempty behavior/evidence');
    }
    const [label, expected] = cells;
    const identity = JSON.stringify([section, label]);
    if (labels.has(identity)) fail(index + 1, `Duplicate capability: ${label}`);
    labels.add(identity);
    const links: string[] = [];
    for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      const path = posix.normalize(posix.join(posix.dirname(featureCoveragePath), decodeURIComponent(target.split(/[?#]/)[0])));
      if (path.startsWith('../') || posix.isAbsolute(path) || path.includes('\\')) fail(index + 1, `Link escapes the repository: ${target}`);
      links.push(path);
    }
    entries.push({
      section, label, expected, evidence: cells[columns - 1], line: index + 1,
      links: [...new Set(links)],
      tests: [...new Set(links.filter(path => /^scripts\/(?:.*\/)?test-[^/]+\.(?:ts|tsx|js|mjs|cjs|ps1)$/.test(path)))],
      publicIds: [...new Set([...source.matchAll(/`(meoEnhanced\.[\w.]+)`/g)].map(match => match[1]))]
    });
  }
  if (!entries.length) fail(1, 'No capability rows found');
  return entries;
}

export function inspectFeatureCoverage(
  entries: readonly FeatureCoverageEntry[],
  manifestIds: readonly string[],
  availableFiles: ReadonlySet<string>,
  releaseTests: ReadonlySet<string>,
  separate: Readonly<Record<string, { kind: string; command: string; reason: string }>>
): string[] {
  const errors: string[] = [];
  const declared = new Set(manifestIds);
  const documented = new Set(entries.flatMap(entry => entry.publicIds));
  for (const id of declared) if (!documented.has(id)) errors.push(`Missing public capability acceptance: ${id}`);
  for (const entry of entries) {
    const at = `${featureCoveragePath}:${entry.line}`;
    for (const id of entry.publicIds) if (!declared.has(id)) errors.push(`${at}: Obsolete public capability: ${id}`);
    for (const path of entry.links) if (!availableFiles.has(path)) errors.push(`${at}: Missing capability reference: ${path}`);
    for (const path of entry.tests) {
      const exception = separate[path];
      const native = exception?.kind === 'native' && exception.reason?.trim() && referencesTestPath(exception.command, path);
      if (!releaseTests.has(path) && !native) errors.push(`${at}: Capability test must enter release or an explicit native gate: ${path}`);
    }
  }
  return errors;
}
