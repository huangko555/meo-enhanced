import { TreeBuffer, type Tree } from '@lezer/common';

const hostNames = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'CommentBlock']);
const hostRanges = new WeakMap<Tree | TreeBuffer, readonly { from: number; to: number }[]>();

/** Relative ranges belong to immutable branches and survive incremental reuse. */
export function markdownLanguageHostRanges(tree: Tree | TreeBuffer): readonly { from: number; to: number }[] {
  const cached = hostRanges.get(tree);
  if (cached) return cached;
  const ranges: { from: number; to: number }[] = [];
  if (tree instanceof TreeBuffer) {
    for (let index = 0; index < tree.buffer.length;) {
      if (hostNames.has(tree.set.types[tree.buffer[index]!]!.name)) {
        ranges.push({ from: tree.buffer[index + 1]!, to: tree.buffer[index + 2]! });
        index = tree.buffer[index + 3]!;
      } else index += 4;
    }
  } else if (hostNames.has(tree.type.name)) ranges.push({ from: 0, to: tree.length });
  else for (let index = 0; index < tree.children.length; index++) {
    const offset = tree.positions[index]!;
    for (const range of markdownLanguageHostRanges(tree.children[index]!)) {
      ranges.push({ from: range.from + offset, to: range.to + offset });
    }
  }
  hostRanges.set(tree, ranges);
  return ranges;
}

/** One small transferable index keeps global discovery off the editing thread. */
export function encodeMarkdownLanguageHosts(tree: Tree): Float64Array {
  const ranges = markdownLanguageHostRanges(tree);
  const packed = new Float64Array(ranges.length * 2);
  for (let index = 0; index < ranges.length; index++) {
    packed[index * 2] = ranges[index]!.from;
    packed[index * 2 + 1] = ranges[index]!.to;
  }
  return packed;
}

export function validateMarkdownLanguageHosts(value: unknown, length: number): asserts value is Float64Array {
  if (!(value instanceof Float64Array) || value.length % 2 !== 0 || value.length > length * 2) {
    throw new Error('Invalid Markdown language hosts');
  }
  let previousTo = 0;
  for (let index = 0; index < value.length; index += 2) {
    const from = value[index]!, to = value[index + 1]!;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < previousTo || to <= from || to > length) {
      throw new Error('Invalid Markdown language hosts');
    }
    previousTo = to;
  }
}
