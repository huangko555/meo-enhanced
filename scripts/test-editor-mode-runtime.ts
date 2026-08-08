import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEditorModeApplication, type EditorMode } from '../webview/src/application/editorMode';
import {
  createEditorModeEffectAdapter,
  type EditorModeEffectCapabilities,
  type EditorModeFailure
} from '../webview/src/adapters/editorModeEffectAdapter';
import { createEditorModeRuntime } from '../webview/src/adapters/editorModeRuntime';

const events: string[] = [];
const errors: string[] = [];
let mountAttempts = 0;
let failLiveOnce = true;
let releaseLateApply: (() => void) | null = null;

const failure = (value: EditorModeFailure): Error & { failure: EditorModeFailure } =>
  Object.assign(new Error(value), { failure: value });

const capabilities: EditorModeEffectCapabilities = {
  commitTransientEdits: () => events.push('commit'),
  async mountEditor(mode) {
    mountAttempts += 1;
    events.push(`mount:${mountAttempts}:${mode}`);
    if (mountAttempts === 1) throw failure('transient-live');
  },
  async applyEditorMode(mode) {
    events.push(`apply:${mode}`);
    if (mode === 'live' && failLiveOnce) {
      failLiveOnce = false;
      throw failure('live-incompatible');
    }
    if (mode === 'live' && releaseLateApply !== null) {
      await new Promise<void>((resolve) => { releaseLateApply = resolve; });
    }
  },
  setPreviewActive: (active, restoreLine) => events.push(`preview:${active}:${restoreLine ?? 'none'}`),
  setEditorVisible: (visible) => events.push(`editor:${visible}`),
  presentModeControl: (mode) => events.push(`control:${mode}`),
  closeFind: () => events.push('close-find'),
  setSearchOwner: (owner) => events.push(`search:${owner}`),
  setOutlineOwner: (owner) => events.push(`outline:${owner}`),
  setReplaceEnabled: (enabled) => events.push(`replace:${enabled}`),
  hideSelectionMenu: () => events.push('hide-selection-menu'),
  captureViewport: () => ({ owner: 'editor', topLine: 9, topLineOffset: 0.5 }),
  restoreViewport: (viewport) => events.push(`restore:${viewport.owner}:${viewport.topLine}`),
  focusEditor: () => events.push('focus'),
  persistMode: (mode, lastEditableMode) => events.push(`persist:${mode}:${lastEditableMode}`),
  postMode: (mode) => events.push(`post:${mode}`),
  showNotice: (notice) => events.push(`notice:${notice}`),
  reportError: (operation) => errors.push(operation),
  classifyError: (error) => (
    typeof error === 'object' && error !== null && 'failure' in error
      ? (error as { failure: EditorModeFailure }).failure
      : 'fatal'
  ),
  dispose: () => events.push('dispose')
};

const application = createEditorModeApplication();
const adapter = createEditorModeEffectAdapter(capabilities);
const runtime = createEditorModeRuntime(application, adapter, (error) => errors.push(String(error)));

await runtime.dispatch({ type: 'restoreLocal', mode: 'live', lastEditableMode: 'live' });
await runtime.dispatch({ type: 'initialize', hostMode: 'source' });
assert.equal(runtime.getState().editorMount, 'mounted');
assert.equal(mountAttempts, 2, 'transient mount failure must retry once through Application effects');
assert.deepEqual(events.slice(0, 4), ['mount:1:live', 'notice:mount-retry', 'mount:2:live', 'commit']);

events.length = 0;
await runtime.dispatch({ type: 'requestMode', mode: 'source', source: 'user', restoreEditorFocus: true });
assert.equal(runtime.getState().mode, 'source');
assert.equal(events.includes('restore:editor:9'), true, 'runtime must enrich mode requests with captured viewport');
assert.equal(events.includes('focus'), true);
assert.ok(events.indexOf('apply:source') < events.indexOf('persist:source:source'));
assert.ok(events.indexOf('persist:source:source') < events.indexOf('post:source'));

events.length = 0;
await runtime.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
assert.equal(runtime.getState().mode, 'source', 'incompatible Live must use the Application fallback');
assert.deepEqual(events.filter((event) => event.startsWith('apply:')), ['apply:live', 'apply:source']);
assert.equal(events.includes('notice:live-fallback'), true);
assert.equal(events.at(-1), 'post:source');

events.length = 0;
await runtime.dispatch({ type: 'requestMode', mode: 'preview', source: 'user' });
assert.equal(runtime.getState().mode, 'preview');
assert.equal(events.some((event) => event.startsWith('preview:true:')), true);
assert.equal(events.includes('editor:false'), true);
assert.equal(events.includes('search:preview'), true);
assert.equal(events.includes('outline:preview'), true);
assert.equal(events.includes('replace:false'), true);
assert.equal(events.includes('hide-selection-menu'), true);

events.length = 0;
const first = runtime.dispatch({ type: 'toggleMode', source: 'user' });
const second = runtime.dispatch({ type: 'requestMode', mode: 'preview', source: 'user' });
await Promise.all([first, second]);
assert.equal(runtime.getState().mode, 'preview', 'queued inputs must retain dispatch order');

events.length = 0;
releaseLateApply = () => undefined;
const late = runtime.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
await new Promise((resolve) => setTimeout(resolve, 0));
runtime.dispose();
const release = releaseLateApply;
assert.ok(release);
release();
await late;
assert.equal(runtime.getState().lifecycle, 'disposed');
assert.equal(events.filter((event) => event === 'dispose').length, 1);
assert.equal(events.some((event) => event.startsWith('persist:live')), false, 'late completion must not finalize state');
await runtime.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
assert.equal(errors.length, 0);

const bestEffortErrors: string[] = [];
const throwingAdapter = createEditorModeEffectAdapter({
  ...capabilities,
  persistMode: () => { throw new Error('persist'); },
  postMode: async () => { throw new Error('post'); },
  showNotice: () => { throw new Error('notice'); },
  reportError: (operation) => bestEffortErrors.push(operation)
});
throwingAdapter.execute({ type: 'persistMode', mode: 'source', lastEditableMode: 'source' });
throwingAdapter.execute({ type: 'postMode', mode: 'source' });
throwingAdapter.execute({ type: 'showNotice', notice: 'editor-failure' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(bestEffortErrors.sort(), ['persist-mode', 'post-mode', 'show-notice']);

let scheduledMountRuns = 0;
let scheduledMountCancels = 0;
const scheduledApplication = createEditorModeApplication();
const scheduledAdapter = createEditorModeEffectAdapter({
  ...capabilities,
  scheduleMount: () => {
    return () => { scheduledMountCancels += 1; };
  },
  mountEditor: () => { scheduledMountRuns += 1; }
});
const scheduledRuntime = createEditorModeRuntime(scheduledApplication, scheduledAdapter, (error) => {
  throw error;
});
const pendingInitialize = scheduledRuntime.dispatch({ type: 'initialize', hostMode: 'source' });
await new Promise((resolve) => setTimeout(resolve, 0));
scheduledRuntime.dispose();
await pendingInitialize;
await scheduledRuntime.whenIdle();
assert.equal(scheduledMountCancels, 1, 'dispose must cancel a scheduled lazy mount');
assert.equal(scheduledMountRuns, 0, 'cancelled lazy mount must not reach the concrete Editor factory');

const adapterSource = readFileSync(new URL('../webview/src/adapters/editorModeEffectAdapter.ts', import.meta.url), 'utf8');
assert.equal(/\b(currentMode|lastEditableMode|pendingText|documentText)\s*=/.test(adapterSource), false);
const bootstrapSource = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
assert.equal(
  (bootstrapSource.match(/editorModeRuntime = createEditorModeRuntime\(/g) ?? []).length,
  1,
  'production must create exactly one Editor Mode Runtime'
);
assert.equal(
  (bootstrapSource.match(/const editorModeEffectAdapter = createEditorModeEffectAdapter\(\{/g) ?? []).length,
  1,
  'production must create exactly one Editor Mode Effect Adapter'
);

console.log('Editor Mode runtime and effect adapter checks passed');
