import { NodeProp, Tree, TreeBuffer, type NodeSet } from '@lezer/common';

type SyntaxObject = Tree | TreeBuffer;
type TreeRecord = { readonly id: number; readonly length: number; readonly type: number;
  readonly children: readonly number[]; readonly positions: readonly number[];
  readonly contextHash?: number; readonly lookAhead?: number };
type BufferRecord = { readonly id: number; readonly length: number; readonly buffer: Uint16Array };
export type MarkdownTreeTransfer = { readonly root: number; readonly count: number;
  readonly records: Float64Array; readonly buffers: Uint16Array };

/** Tree records: id, length, type, child count, context hash, look-ahead, then
 * child-id/position pairs. Buffer records: id, length, -1, offset, unit count.
 * Doubles preserve safe IDs and signed hashes without per-record wire objects. */
function pack(root: number, records: readonly (TreeRecord | BufferRecord)[]): MarkdownTreeTransfer {
  let fields = 0, units = 0;
  for (const record of records) {
    fields += 'buffer' in record ? 5 : 6 + record.children.length * 2;
    if ('buffer' in record) units += record.buffer.length;
  }
  const metadata = new Float64Array(fields), buffers = new Uint16Array(units);
  let cursor = 0, offset = 0;
  for (const record of records) {
    metadata[cursor++] = record.id; metadata[cursor++] = record.length;
    if ('buffer' in record) {
      metadata[cursor++] = -1; metadata[cursor++] = offset; metadata[cursor++] = record.buffer.length;
      buffers.set(record.buffer, offset); offset += record.buffer.length;
    } else {
      metadata[cursor++] = record.type; metadata[cursor++] = record.children.length;
      metadata[cursor++] = record.contextHash ?? NaN; metadata[cursor++] = record.lookAhead ?? NaN;
      for (let index = 0; index < record.children.length; index++) {
        metadata[cursor++] = record.children[index]!; metadata[cursor++] = record.positions[index]!;
      }
    }
  }
  return { root, count: records.length, records: metadata, buffers };
}

/** Roots own graph edges, so exchanging one revision retires only branches that
 * are no longer shared. No whole-tree sweep or unbounded revision cache. */
class RetainedNodes {
  readonly entries = new Map<number, { node: SyntaxObject; children: readonly number[]; references: number }>();
  private root = 0;
  constructor(private readonly retire: (node: SyntaxObject) => void = () => {}) {}

  add(id: number, node: SyntaxObject, children: readonly number[]) {
    if (this.entries.has(id)) throw new Error('Duplicate Markdown syntax node');
    for (const child of children) {
      const entry = this.entries.get(child);
      if (!entry) throw new Error('Unknown Markdown syntax child');
      entry.references++;
    }
    this.entries.set(id, { node, children, references: 0 });
  }

  select(id: number): Tree {
    const entry = this.entries.get(id);
    if (!(entry?.node instanceof Tree)) throw new Error('Unknown Markdown syntax root');
    entry.references++;
    const previous = this.root; this.root = id;
    if (previous) this.release(previous);
    return entry.node;
  }

  private release(id: number) {
    const entry = this.entries.get(id)!;
    if (--entry.references) return;
    this.entries.delete(id); this.retire(entry.node);
    for (const child of entry.children) this.release(child);
  }

  clear() {
    for (const entry of this.entries.values()) this.retire(entry.node);
    this.entries.clear(); this.root = 0;
  }
}

/** Encode only newly allocated immutable branches. Two aggregate buffers cross
 * threads; the parser retains its originals for incremental reuse. */
export function createMarkdownTreeEncoder() {
  const ids = new WeakMap<SyntaxObject, number>();
  const retained = new RetainedNodes(node => ids.delete(node));
  let sequence = 0;
  return {
    encode(tree: Tree): { value: MarkdownTreeTransfer; transfers: ArrayBuffer[] } {
      const records: Array<TreeRecord | BufferRecord> = [];
      const encode = (node: SyntaxObject): number => {
        const known = ids.get(node);
        if (known !== undefined) return known;
        const id = ++sequence;
        if (node instanceof TreeBuffer) {
          records.push({ id, length: node.length, buffer: node.buffer });
          retained.add(id, node, []);
        } else {
          if (node.prop(NodeProp.mounted)) throw new Error('Only outer Markdown syntax can cross this boundary');
          const children = node.children.map(encode);
          records.push({ id, length: node.length, type: node.type.id, children, positions: node.positions,
            contextHash: node.prop(NodeProp.contextHash), lookAhead: node.prop(NodeProp.lookAhead) });
          retained.add(id, node, children);
        }
        ids.set(node, id);
        return id;
      };
      try {
        const root = encode(tree);
        retained.select(root);
        const value = pack(root, records);
        return { value, transfers: [value.records.buffer as ArrayBuffer, value.buffers.buffer as ArrayBuffer] };
      } catch (error) { retained.clear(); throw error; }
    },
    get retainedNodes() { return retained.entries.size; },
    clear: () => retained.clear()
  };
}

/** Every response must be accepted in wire order, even if its presentation is
 * obsolete: a later patch can refer to its shared branches. */
export function createMarkdownTreeReceiver(nodeSet: NodeSet) {
  const retained = new RetainedNodes();
  return {
    receive(value: MarkdownTreeTransfer): Tree {
      try {
        if (!(value.records instanceof Float64Array) || !(value.buffers instanceof Uint16Array)
          || !Number.isSafeInteger(value.count) || value.count < 0
          || !Number.isSafeInteger(value.root) || value.root <= 0) throw new Error('Invalid Markdown syntax packet');
        let cursor = 0, count = 0, bufferOffset = 0;
        const fields = value.records;
        while (cursor < fields.length) {
          if (fields.length - cursor < 5) throw new Error('Truncated Markdown syntax record');
          const id = fields[cursor++]!, length = fields[cursor++]!, kind = fields[cursor++]!;
          if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(length) || length < 0) {
            throw new Error('Invalid Markdown syntax record');
          }
          count++;
          if (kind === -1) {
            const offset = fields[cursor++]!, units = fields[cursor++]!;
            if (offset !== bufferOffset || !Number.isSafeInteger(units) || units < 0 || units % 4
              || units > value.buffers.length - offset) throw new Error('Invalid Markdown syntax buffer');
            // Each retained branch owns its bytes. A tiny surviving branch must
            // not pin an obsolete document's entire aggregate transfer buffer.
            retained.add(id, new TreeBuffer(value.buffers.slice(offset, offset + units), length, nodeSet), []);
            bufferOffset += units;
          } else {
            const type = nodeSet.types[kind], childCount = fields[cursor++]!;
            if (!Number.isInteger(kind) || !type || !Number.isSafeInteger(childCount) || childCount < 0
              || fields.length - cursor < 2 || childCount > (fields.length - cursor - 2) / 2) throw new Error('Invalid Markdown syntax children');
            const contextHash = fields[cursor++]!, lookAhead = fields[cursor++]!;
            if (!Number.isNaN(contextHash) && !Number.isSafeInteger(contextHash)
              || !Number.isNaN(lookAhead) && (!Number.isSafeInteger(lookAhead) || lookAhead < 0)) throw new Error('Invalid Markdown syntax properties');
            const children: SyntaxObject[] = [], ids: number[] = [], positions: number[] = [];
            for (let index = 0; index < childCount; index++) {
              const childId = fields[cursor++]!, position = fields[cursor++]!, node = retained.entries.get(childId)?.node;
              if (!Number.isSafeInteger(childId) || !node || !Number.isSafeInteger(position) || position < 0
                || position + node.length > length || index > 0 && position < positions[index - 1]!) throw new Error('Invalid Markdown syntax position');
              children.push(node); ids.push(childId); positions.push(position);
            }
            const props: NonNullable<ConstructorParameters<typeof Tree>[4]>[number][] = [];
            if (!Number.isNaN(contextHash)) props.push([NodeProp.contextHash, contextHash]);
            if (!Number.isNaN(lookAhead)) props.push([NodeProp.lookAhead, lookAhead]);
            retained.add(id, new Tree(type, children, positions, length, props), ids);
          }
        }
        if (count !== value.count || bufferOffset !== value.buffers.length) throw new Error('Invalid Markdown syntax packet length');
        return retained.select(value.root);
      } catch (error) { retained.clear(); throw error; }
    },
    get retainedNodes() { return retained.entries.size; },
    clear: () => retained.clear()
  };
}
