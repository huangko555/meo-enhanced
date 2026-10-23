import { AlertTriangle, BrushCleaning, Check, createElement } from 'lucide';

export type SourceFormatOutcome = 'formatted' | 'formatted-protected' | 'unchanged' | 'boundary' | 'unsafe' | 'unsupported' | 'invalid' | 'changed' | 'unavailable';
type Messages = Record<SourceFormatOutcome, string> & { idle: string; busy: string };
type Feedback = { busy: boolean; revision: object; outcome?: SourceFormatOutcome; timer?: ReturnType<typeof setTimeout>; subscribers: Set<() => void> };
const feedbackByOwner = new WeakMap<object, Map<string, Feedback>>();

/** Feedback survives source widget replacement. Owners dispose each mounted control. */
export function createSourceFormatButton(owner: object, key: string, revision: () => object, document: Document, messages: () => Messages,
  run: (isCurrent: () => boolean) => Promise<SourceFormatOutcome>) {
  let feedbacks = feedbackByOwner.get(owner);
  if (!feedbacks) { feedbacks = new Map(); feedbackByOwner.set(owner, feedbacks); }
  let feedback = feedbacks.get(key);
  if (!feedback) { feedback = { busy: false, revision: revision(), subscribers: new Set() }; feedbacks.set(key, feedback); }
  const state = feedback;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-source-format-btn';
  button.contentEditable = 'false';
  button.dataset.tooltipLiveUpdate = 'true';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  let disposed = false;
  const label = (value: string) => { button.dataset.tooltip = value; button.setAttribute('aria-label', value); };
  const refresh = () => {
    const current = revision();
    if (state.revision !== current && !state.busy) { clearTimeout(state.timer); state.timer = undefined; state.outcome = undefined; }
    state.revision = current;
    button.disabled = state.busy;
    if (state.busy) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    const success = state.outcome === 'formatted' || state.outcome === 'formatted-protected' || state.outcome === 'unchanged';
    icon.replaceChildren(createElement(!state.outcome ? BrushCleaning : success ? Check : AlertTriangle, { width: 14, height: 14 }));
    label(state.busy ? messages().busy : state.outcome ? messages()[state.outcome] : messages().idle);
    // Retain the persisted command ID so existing customized bindings still apply.
    if (!state.busy && !state.outcome) button.dataset.tooltipCommand = 'formatHtml';
    else { delete button.dataset.tooltipCommand; delete button.dataset.tooltipShortcut; }
  };
  state.subscribers.add(refresh);
  const notify = () => state.subscribers.forEach(refresh => refresh());
  const release = () => queueMicrotask(() => {
    // CodeMirror can destroy and mount the same block's widget within one update.
    if (!state.subscribers.size && !state.busy && !state.outcome && feedbacks!.get(key) === state) {
      clearTimeout(state.timer); feedbacks!.delete(key);
    }
  });
  for (const type of ['pointerdown', 'mousedown']) button.addEventListener(type, event => {
    event.preventDefault(); event.stopPropagation();
  });
  button.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation();
    if (button.disabled || disposed) return;
    clearTimeout(state.timer); state.timer = undefined;
    state.busy = true; state.outcome = undefined; notify();
    let outcome: SourceFormatOutcome;
    try { outcome = await run(() => feedbacks!.get(key) === state && state.subscribers.size > 0); }
    catch { outcome = 'invalid'; }
    if (feedbacks!.get(key) !== state) return;
    state.revision = revision(); state.busy = false; state.outcome = outcome; notify();
    state.timer = setTimeout(() => { state.timer = undefined; state.outcome = undefined; notify(); release(); }, 2500);
    if (!state.subscribers.size) release();
  });
  refresh();
  return { button, refresh, dispose() { disposed = true; state.subscribers.delete(refresh); release(); } };
}
