import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';

class Disposable { constructor(private run: () => void) {} dispose() { this.run(); } }
class EventEmitter<T> {
  listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => { this.listeners.add(listener); return new Disposable(() => { this.listeners.delete(listener); }); };
  fire(value: T) { this.listeners.forEach(listener => listener(value)); }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(readonly value: string) {}
  static joinPath(uri: Uri, ...parts: string[]) { return new Uri([uri.value, ...parts].join('/')); }
  toString() { return this.value; }
}
const installed = new Map<string, any>([['test.markmap', { id: 'test.markmap', extensionUri: new Uri('file:///extension') }]]);
const configurationChanged = new EventEmitter<any>(), extensionsChanged = new EventEmitter<void>();
let disabledFeatures: string[] = [], failWrite = false;
const openedDetails: unknown[][] = [];
mock.module('vscode', () => ({ Disposable, EventEmitter, Uri, ConfigurationTarget: { Global: 1 },
  commands: { executeCommand: async (...args: unknown[]) => { openedDetails.push(args); } },
  extensions: { getExtension: (id: string) => installed.get(id), onDidChange: extensionsChanged.event },
  workspace: { onDidChangeConfiguration: configurationChanged.event, getConfiguration: () => ({
    get: () => disabledFeatures, update: async (_key: string, value: string[], target: number) => {
      assert.equal(target, 1); if (failWrite) throw new Error('fixture configuration failure');
      disabledFeatures = value; configurationChanged.fire({ affectsConfiguration: () => true });
    }
  }) }
}));
const { createDocumentViewsRegistry } = await import('../src/extension/documentViews');
const registry = createDocumentViewsRegistry();
const messages: any[] = [], ready = new EventEmitter<unknown>(), closed = new EventEmitter<void>();
let initialized = false;
const panel = { webview: { options: { enableScripts: true, localResourceRoots: [new Uri('file:///core')] }, onDidReceiveMessage: ready.event,
  asWebviewUri: (uri: Uri) => new Uri(uri.value.replace('file://', 'https://resource.test')),
  postMessage: async (event: unknown) => { assert(initialized); messages.push(event); return true; }
}, onDidDispose: closed.event };
let options = panel.webview.options, optionWrites = 0;
Object.defineProperty(panel.webview, 'options', { get: () => options, set: next => { options = next; optionWrites++; } });
registry.attach(panel as any, async () => { initialized = true; });
const descriptor = { id: 'mindmap', label: 'Mind map', labelZh: '思维导图', entry: 'dist/view.js', iconPaths: ['M2 12H22'], iconOffset: { x: -0.5, y: 0 }, codeBlockLanguages: ['markmap'] };
for (const codeBlockLanguages of [[], ['mermaid'], ['markmap', 'markmap'], ['<script>']]) {
  assert.throws(() => registry.api.registerDocumentView('test.markmap', { ...descriptor, codeBlockLanguages }));
}
for (const x of [NaN, Infinity, 2]) assert.throws(() => registry.api.registerDocumentView('test.markmap', { ...descriptor, iconOffset: { x, y: 0 } }));
assert.throws(() => registry.api.registerDocumentView('test.markmap', { ...descriptor, iconPaths: ['<svg onload="alert(1)">'] }));
for (const entry of ['../view.js', 'dist/../view.js', '/dist/view.js', 'https://untrusted/view.js']) {
  assert.throws(() => registry.api.registerDocumentView('test.markmap', { ...descriptor, entry }));
}
assert.throws(() => registry.api.registerDocumentView('missing', descriptor));
const contribution = registry.api.registerDocumentView('test.markmap', descriptor);
assert.throws(() => registry.api.registerDocumentView('test.markmap', { ...descriptor, id: 'duplicate-language' }));
assert.throws(() => registry.api.registerDocumentView('test.markmap', descriptor));
assert.equal(messages.length, 0);
ready.fire({ type: 'ready', pageId: 'document-views-page-1' }); await Promise.resolve(); await Promise.resolve();
assert.equal(messages.at(-1).views[0].id, 'test.markmap/mindmap');
assert.deepEqual(messages.at(-1).views[0].iconPaths, descriptor.iconPaths);
assert.deepEqual(messages.at(-1).views[0].iconOffset, descriptor.iconOffset);
assert.equal(panel.webview.options.localResourceRoots.length, 2);
assert.deepEqual(decodeHostToWebviewMessage(messages.at(-1)), messages.at(-1));
const writes = optionWrites;
ready.fire({ type: 'ready', pageId: 'document-views-page-1' }); await Promise.resolve(); await Promise.resolve();
assert.equal(optionWrites, writes, 'Repeated ready must not update Webview options and reload the editor');
assert.equal(decodeHostToWebviewMessage({ type: 'documentViewsChanged', views: [{ ...messages.at(-1).views[0], entryUri: 4 }] }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'documentViewsChanged', views: [{ ...messages.at(-1).views[0], iconOffset: { x: 4, y: 0 } }] }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'documentViewsChanged', views: [{ ...messages.at(-1).views[0], iconPaths: ['url(https://example.com)'] }] }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'documentViewsChanged', views: [messages.at(-1).views[0], messages.at(-1).views[0]] }), null);
const blockRegistration = { id: 'plantuml', label: 'PlantUML', entry: 'dist/plantuml/renderer.js', codeBlockLanguages: ['plantuml', 'puml'] };
assert.throws(() => registry.api.registerCodeBlockRenderer!('test.markmap', { ...blockRegistration, codeBlockLanguages: [] }));
const block = registry.api.registerCodeBlockRenderer!('test.markmap', blockRegistration);
await Promise.resolve(); await Promise.resolve();
assert.equal(messages.at(-1).views[1].blockOnly, true);
assert.deepEqual(decodeHostToWebviewMessage(messages.at(-1)), messages.at(-1));
assert.equal(decodeHostToWebviewMessage({ type: 'documentViewsChanged', views: [{ ...messages.at(-1).views[1], codeBlockLanguages: undefined }] }), null);
block.dispose();
contribution.dispose(); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(messages.at(-1).views, []); assert.equal(panel.webview.options.localResourceRoots.length, 2);
assert.equal(optionWrites, writes, 'Disabling a view preserves resource roots and does not reload the editor');
closed.fire(); const count = messages.length;
registry.api.registerDocumentView('test.markmap', descriptor); ready.fire({ type: 'ready', pageId: 'document-views-page-1' }); await Promise.resolve();
assert.equal(messages.length, count); registry.dispose();
console.log('Document view registration, lifecycle, resource roots and protocol checks passed');

const { createExtensionFeatures } = await import('../src/extension/extensionFeatures');
const features = createExtensionFeatures();
assert.deepEqual(features.state(), { installed: false, version: '', features: [] });
const extrasId = 'huangko555.meo-extras';
installed.set(extrasId, { id: extrasId, extensionUri: new Uri('file:///extras'), packageJSON: { version: '0.1.0' } });
disabledFeatures = ['mindmap'];
const views = createDocumentViewsRegistry();
let activations = 0, disposals = 0;
const feature = features.registerFeature(extrasId, { id: 'mindmap', label: 'Mind map' }, () => {
  activations++; const owned = views.api.registerDocumentView(extrasId, descriptor);
  return { dispose() { disposals++; owned.dispose(); } };
});
assert.equal(activations, 0, 'Disabled features register metadata without starting runtime');
const panels = [0, 1].map((_, index) => {
  const incoming = new EventEmitter<any>(), closed = new EventEmitter<void>(), events: any[] = [];
  let options = { localResourceRoots: [new Uri('file:///core')] }, writes = 0;
  const panel = { webview: { get options() { return options; }, set options(value) { options = value; writes++; },
    onDidReceiveMessage: incoming.event, asWebviewUri: (uri: Uri) => uri,
    postMessage: async (event: any) => { events.push(event); return true; } }, onDidDispose: closed.event };
  views.attach(panel as any, async () => {}); features.attach(panel as any, async () => {});
  incoming.fire({ type: 'ready', pageId: `document-views-feature-page-${index + 1}` });
  return { incoming, closed, events, writes: () => writes };
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
await settle();
const request = async (id: string, enabled: boolean) => {
  const requestId = `request-${panels[0].events.length}`;
  const message = { type: 'extensionFeaturesRequest', requestId, action: 'setEnabled', id, enabled };
  assert.deepEqual(decodeWebviewToHostMessage(message), message);
  panels[0].incoming.fire(message); await settle();
  return panels[0].events.findLast(e => e.type === 'extensionFeaturesResult' && e.requestId === requestId);
};
assert.equal((await request('mindmap', true)).failed, false);
assert.equal(activations, 1); assert.equal(disposals, 0);
assert.deepEqual(disabledFeatures, []);
assert.equal(panels[1].events.findLast(e => e.type === 'extensionFeaturesChanged').state.features[0].active, true);
assert.equal((await request('mindmap', false)).state.features[0].active, false);
assert.equal(disposals, 1);
assert.deepEqual(panels[1].events.findLast(e => e.type === 'documentViewsChanged').views, []);
await request('mindmap', true); assert.equal(activations, 2);
assert(panels.every(p => p.writes() === 1), 'Toggle off/on never reloads either Webview');
const originalError = console.error; console.error = () => {};
try {
  failWrite = true;
  assert.equal((await request('mindmap', false)).failed, true);
  assert.equal(features.state().features[0].enabled, true); assert.equal(disposals, 1);
  failWrite = false;
  assert.equal((await request('unknown', false)).failed, true);
  let attempts = 0, independentStarts = 0, independentStops = 0;
  const broken = features.registerFeature(extrasId, { id: 'broken', label: 'Broken' }, () => { attempts++; throw new Error('fixture activation failure'); });
  const independent = features.registerFeature(extrasId, { id: 'independent', label: 'Independent' }, () => {
    independentStarts++; return { dispose() { independentStops++; } };
  });
  assert.equal(features.state().features.find(f => f.id === 'broken')!.failed, true);
  await request('mindmap', false); await request('mindmap', true);
  configurationChanged.fire({ affectsConfiguration: () => true });
  assert.equal(attempts, 1, 'Registration, unrelated toggles and repeated config delivery never retry another failed feature');
  assert.equal(independentStarts, 1); assert.equal(independentStops, 0);
  await request('broken', false); await request('broken', true);
  assert.equal(attempts, 2, 'Only an explicit off/on retries the failed feature');
  await request('independent', false);
  assert.equal(independentStops, 1); assert.equal(features.state().features.find(f => f.id === 'mindmap')!.active, true);
  broken.dispose(); independent.dispose();
  let cleaned = false;
  const cleanup = createExtensionFeatures();
  cleanup.registerFeature(extrasId, { id: 'throws-on-dispose', label: 'Throws' }, () => ({ dispose() { throw new Error('fixture disposal failure'); } }));
  cleanup.registerFeature(extrasId, { id: 'cleans-up', label: 'Cleans' }, () => ({ dispose() { cleaned = true; } }));
  cleanup.dispose(); assert.equal(cleaned, true, 'One disposal failure cannot prevent other features from releasing resources');
} finally { console.error = originalError; failWrite = false; }
const details = { type: 'extensionFeaturesRequest', requestId: 'details', action: 'openDetails' };
assert.deepEqual(decodeWebviewToHostMessage(details), details);
panels[0].incoming.fire(details); await settle();
assert.deepEqual(openedDetails, [['extension.open', extrasId]], 'Guide opens only the installed companion details');
for (const enabled of ['true', null, 0]) assert.equal(decodeWebviewToHostMessage({ type: 'extensionFeaturesRequest', requestId: 'bad', action: 'setEnabled', id: 'mindmap', enabled }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'extensionFeaturesChanged', state: { ...features.state(), features: [features.state().features[0], features.state().features[0]] } }), null);
assert.deepEqual(decodeHostToWebviewMessage({ type: 'extensionFeaturesChanged', state: features.state() })?.type, 'extensionFeaturesChanged');
await request('mindmap', false); feature.dispose();
const restored = features.registerFeature(extrasId, { id: 'mindmap', orderId: 10, label: 'Mind map' }, () => { throw new Error('Disabled feature must stay disabled after changing order'); });
assert.equal(features.state().features[0].enabled, false); assert.equal(features.state().features[0].failed, false);
const reordered = features.registerFeature(extrasId, { id: 'plantuml', orderId: 2, label: 'PlantUML' }, () => ({ dispose() {} }));
assert.deepEqual(features.state().features.map(f => f.id), ['plantuml', 'mindmap'], 'Numeric IDs sort numerically regardless of registration order');
for (const orderId of [-1, 1.5, NaN, Infinity, '1']) assert.throws(() => features.registerFeature(extrasId, { id: 'invalid', label: 'Invalid', orderId } as any, () => ({ dispose() {} })));
reordered.dispose();
restored.dispose(); panels.forEach(p => p.closed.fire()); features.dispose(); views.dispose();
console.log('Extras feature persistence, activation/disposal, multi-panel sync, failure handling and protocol passed');
