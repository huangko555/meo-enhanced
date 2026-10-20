import { NodeProp, Tree, TreeBuffer, type NodeSet } from '@lezer/common';

type SyntaxObject = Tree | TreeBuffer;
type TreeRecord = { readonly id: number; readonly length: number; readonly type: number;
  readonly children: readonly number[]; readonly positions: readonly number[];
  readonly contextHash?: number; readonly lookAhead?: number };
type BufferRecord = { readonly id: number; readonly length: number; readonly buffer: Uint16Array };
export type MarkdownTreeTransfer = { readonly root: number; readonly records: readonly (TreeRecord | BufferRecord)[] };

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

/** Encode only newly allocated immutable branches. Transfer copies of packed
 * buffers because the parser retains its originals for incremental reuse. */
export function createMarkdownTreeEncoder() {
  const ids = new WeakMap<SyntaxObject, number>();
  const retained = new RetainedNodes(node => ids.delete(node));
  let sequence = 0;
  return {
    encode(tree: Tree): { value: MarkdownTreeTransfer; transfers: ArrayBuffer[] } {
      const records: Array<TreeRecord | BufferRecord> = [], transfers: ArrayBuffer[] = [];
      const encode = (node: SyntaxObject): number => {
        const known = ids.get(node);
        if (known !== undefined) return known;
        const id = ++sequence;
        if (node instanceof TreeBuffer) {
          const buffer = node.buffer.slice();
          records.push({ id, length: node.length, buffer }); transfers.push(buffer.buffer);
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
        return { value: { root, records }, transfers };
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
        for (const record of value.records) {
          if (!Number.isSafeInteger(record.id) || record.id <= 0 || !Number.isSafeInteger(record.length) || record.length < 0) {
            throw new Error('Invalid Markdown syntax record');
          }
          if ('buffer' in record) {
            if (!(record.buffer instanceof Uint16Array) || record.buffer.length % 4) throw new Error('Invalid Markdown syntax buffer');
            retained.add(record.id, new TreeBuffer(record.buffer, record.length, nodeSet), []);
          } else {
            const type = nodeSet.types[record.type];
            if (!Number.isInteger(record.type) || !type || record.children.length !== record.positions.length) throw new Error('Invalid Markdown syntax children');
            const children = record.children.map((id, index) => {
              const node = retained.entries.get(id)?.node, position = record.positions[index]!;
              if (!node || !Number.isSafeInteger(position) || position < 0 || position + node.length > record.length
                || index > 0 && position < record.positions[index - 1]!) throw new Error('Invalid Markdown syntax position');
              return node;
            });
            const props: NonNullable<ConstructorParameters<typeof Tree>[4]>[number][] = [];
            if (record.contextHash !== undefined) props.push([NodeProp.contextHash, record.contextHash]);
            if (record.lookAhead !== undefined) props.push([NodeProp.lookAhead, record.lookAhead]);
            retained.add(record.id, new Tree(type, children, record.positions, record.length, props), record.children);
          }
        }
        return retained.select(value.root);
      } catch (error) { retained.clear(); throw error; }
    },
    get retainedNodes() { return retained.entries.size; },
    clear: () => retained.clear()
  };
}
