import assert from 'node:assert/strict';
import { createMermaidElkLayoutClient } from '../webview/src/adapters/mermaidElkLayout';
import type { ElkLayoutRequest, ElkLayoutResponse } from '../src/protocol/elkLayout';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function transports() {
  const channels: Array<{ receive(value: ElkLayoutResponse): void; fail(error: Error): void; sent: ElkLayoutRequest[]; closed: boolean }> = [];
  return { channels, create: async (_uri: string, receive: (value: ElkLayoutResponse) => void, fail: (error: Error) => void) => {
    const channel = { receive, fail, sent: [] as ElkLayoutRequest[], closed: false };
    channels.push(channel);
    return { send(value: ElkLayoutRequest) { channel.sent.push(structuredClone(value)); }, dispose() { channel.closed = true; } };
  } };
}
const graph = (id: string) => ({ id, children: [{ id: 'a', width: 40, height: 20 }, { id: 'b', width: 40, height: 20 }],
  edges: [{ id: 'edge', sources: ['a'], targets: ['b'] }] });

// Layout crosses a real structured-clone boundary while renderer objects and
// aliases retained by Mermaid's nodeDb keep their identity on the surface.
{
  const fake = transports(), client = createMermaidElkLayoutClient('/worker', { createTransport: fake.create });
  class RenderHandle { readonly value = 42; }
  const draw = () => 'render', handle = new RenderHandle();
  const firstNode = { id: 'a', width: 40, height: 20, draw, handle, labels: [{ text: 'First', width: 25, height: 12 }] };
  const secondNode = { id: 'b', width: 40, height: 20 };
  const source = { id: 'root', children: [firstNode, secondNode], edges: [{ id: 'edge', sources: ['a'], targets: ['b'] }] };
  const children = source.children, labels = firstNode.labels;
  const first = client.layout(source, { layoutOptions: { 'elk.direction': 'RIGHT' } });
  const second = client.layout(graph('second'));
  await turn();
  assert.equal(fake.channels.length, 1); assert.equal(fake.channels[0]!.sent.length, 1, 'one layout is in flight');
  const wire = fake.channels[0]!.sent[0]!;
  assert.equal((wire.graph.children![0] as any).draw, undefined);
  assert.equal((wire.graph.children![0] as any).handle, undefined);
  assert.equal(wire.options?.layoutOptions?.['elk.direction'], 'RIGHT');
  const computed = structuredClone(wire.graph);
  computed.children!.reverse();
  computed.children![0]!.x = 100; computed.children![1]!.x = 10;
  computed.children![1]!.labels![0]!.x = 4;
  fake.channels[0]!.receive({ id: wire.id, graph: computed });
  assert.equal(await first, source); assert.equal(source.children, children);
  assert.equal(source.children[0], secondNode); assert.equal(source.children[1], firstNode);
  assert.equal(firstNode.draw, draw); assert.equal(firstNode.handle, handle);
  assert.equal(firstNode.labels, labels); assert.equal((firstNode as any).x, 10);
  assert.equal((labels[0] as any).x, 4);
  await turn();
  const next = fake.channels[0]!.sent[1]!;
  fake.channels[0]!.receive({ id: next.id, error: 'Unsupported layout option' });
  await assert.rejects(second, /Unsupported layout option/);
  assert.equal(fake.channels[0]!.closed, false, 'a graph error does not poison the shared engine');
  client.dispose(); assert.ok(fake.channels[0]!.closed);
}

for (const reason of ['worker error', 'revision mismatch'] as const) {
  const fake = transports(), client = createMermaidElkLayoutClient('/worker', { createTransport: fake.create });
  const outcomes = Promise.allSettled([client.layout(graph('first')), client.layout(graph('queued'))]);
  await turn();
  const old = fake.channels[0]!;
  if (reason === 'worker error') old.fail(new Error('Fixture worker failure'));
  else old.receive({ id: old.sent[0]!.id + 1, graph: graph('wrong') });
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
  assert.ok(old.closed, `${reason} retires the worker and queued work`);
  let settled = false;
  const retried = client.layout(graph('retry')).finally(() => { settled = true; });
  await turn();
  old.receive({ id: old.sent[0]!.id, graph: graph('late') });
  await turn(); assert.equal(settled, false, 'old-generation results cannot settle a new layout');
  const current = fake.channels[1]!, request = current.sent[0]!;
  current.receive({ id: request.id, graph: request.graph });
  assert.equal((await retried).id, 'retry');
  client.dispose();
}

{
  const fake = transports(), client = createMermaidElkLayoutClient('/worker', { createTransport: fake.create, timeoutMs: 20 });
  const results = await Promise.allSettled([client.layout(graph('slow')), client.layout(graph('queued'))]);
  assert.ok(results.every(result => result.status === 'rejected' && String(result.reason).includes('timed out')));
  assert.ok(fake.channels[0]!.closed, 'timeout terminates the algorithm instead of running it on the UI thread');
  client.dispose();
}

{
  const fake = transports(), client = createMermaidElkLayoutClient('/worker', { createTransport: fake.create, idleMs: 5, maxQueued: 1 });
  const first = client.layout(graph('first')); await turn();
  const queued = client.layout(graph('queued'));
  await assert.rejects(client.layout(graph('overflow')), /queue is full/);
  const request = fake.channels[0]!.sent[0]!;
  fake.channels[0]!.receive({ id: request.id, graph: request.graph }); await first; await turn();
  const next = fake.channels[0]!.sent[1]!;
  fake.channels[0]!.receive({ id: next.id, graph: next.graph }); await queued;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fake.channels[0]!.closed, 'idle layout workers release memory across mode changes');
  const resumed = client.layout(graph('resumed')); await turn();
  const resume = fake.channels[1]!.sent[0]!;
  fake.channels[1]!.receive({ id: resume.id, graph: resume.graph }); await resumed;
  client.dispose(); await assert.rejects(client.layout(graph('closed')), /closed/);
}

{
  let finish!: (transport: { send(request: ElkLayoutRequest): void; dispose(): void }) => void, closed = false;
  const client = createMermaidElkLayoutClient('/worker', { createTransport: () => new Promise(resolve => { finish = resolve; }) });
  const result = client.layout(graph('loading'));
  client.dispose(); await assert.rejects(result, /closed/);
  finish({ send() { assert.fail('a disposed loader must not send a layout'); }, dispose() { closed = true; } });
  await turn(); assert.ok(closed, 'a late worker startup is retired after client disposal');
}
console.log('ELK layout client: renderer aliases, cloneable data, serial queue, errors/retry, stale replies, timeout, idle retirement and disposal passed');
