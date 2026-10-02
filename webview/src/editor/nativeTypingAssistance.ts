import type { InputAssistance } from '../../../src/foundation/editingPreferences';
import { planSymbolInput, shouldDeleteSymbolPair } from '../application/symbolInput';
import type { AutomaticSymbolPair } from './typingAssistance';

export interface NativeSymbolInput { snapshot(): readonly AutomaticSymbolPair[]; reset(): void }
const controllers = new WeakMap<HTMLTextAreaElement, NativeSymbolInput>();
export const nativeSymbolInput = (input: HTMLTextAreaElement) => controllers.get(input);

/** Transforms only committed native input. Input events still flow through the cell commit owner. */
export function wireNativeSymbolInput(input: HTMLTextAreaElement, options: {
  preferences(): InputAssistance;
  originEpoch(): number;
  readOrigins(): readonly AutomaticSymbolPair[];
}): NativeSymbolInput {
  let epoch = options.originEpoch();
  let value = input.value;
  let pairs = options.readOrigins().slice();
  let composing = false;
  let composition: { value: string; from: number; to: number; backward: boolean; pairs: readonly AutomaticSymbolPair[] } | null = null;
  const valid = (pair: AutomaticSymbolPair) => pair.to > pair.from && input.value.slice(pair.from, pair.from + pair.open.length) === pair.open && input.value.slice(pair.to - pair.close.length, pair.to) === pair.close;
  const sync = () => {
    const next = input.value;
    if (epoch !== options.originEpoch()) { epoch = options.originEpoch(); value = next; pairs = options.readOrigins().slice(); composition = null; return; }
    if (next === value) return;
    let from = 0, oldTo = value.length, newTo = next.length;
    while (from < oldTo && from < newTo && value[from] === next[from]) from++;
    while (oldTo > from && newTo > from && value[oldTo - 1] === next[newTo - 1]) { oldTo--; newTo--; }
    const map = (position: number, association: number) => position < from || position === from && association < 0 ? position : position > oldTo || position === oldTo && association > 0 ? position + newTo - oldTo : association < 0 ? from : newTo;
    pairs = pairs.map(pair => ({ ...pair, from: map(pair.from, 1), to: map(pair.to, -1) })).filter(valid);
    value = next;
  };
  const transform = (typed: string, from: number, to: number, previous: string, backward: boolean, origins: readonly AutomaticSymbolPair[], committed = false): boolean => {
    const plan = planSymbolInput({ typed, selected: previous.slice(from, to), before: previous.slice(Math.max(0, from - 256), from), after: previous.slice(to, to + 4), automaticRight: origins.some(pair => pair.to - pair.close.length === to), preferences: options.preferences() });
    if (!plan) return false;
    if (committed) { input.value = previous; input.setSelectionRange(from, to); }
    pairs = origins.slice(); value = previous;
    if (plan.type === 'skip') { input.setSelectionRange(to + plan.length, to + plan.length); return true; }
    input.setRangeText(plan.text, from, to, 'end'); sync();
    pairs.push({ from, to: from + plan.text.length, open: plan.open, close: plan.close });
    input.setSelectionRange(from + plan.anchor, from + plan.head, backward ? 'backward' : 'forward');
    return true;
  };
  const emit = (data: string | null, inputType: string) => input.dispatchEvent(new InputEvent('input', { bubbles: true, data, inputType }));
  const controller: NativeSymbolInput = { snapshot() { sync(); return pairs.slice(); }, reset() { epoch = options.originEpoch(); value = input.value; pairs = options.readOrigins().slice(); composition = null; } };
  controllers.set(input, controller);
  input.addEventListener('focus', () => controller.reset());
  input.addEventListener('beforeinput', event => {
    if (composing || event.isComposing || event.inputType !== 'insertText' || event.data?.length !== 1) return;
    sync();
    if (!transform(event.data, input.selectionStart, input.selectionEnd, input.value, input.selectionDirection === 'backward', pairs)) return;
    event.preventDefault(); emit(event.data, 'insertText');
  });
  input.addEventListener('input', () => {
    if (composition && !composing) finishComposition();
    sync();
  });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.key !== 'Backspace' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || input.selectionStart !== input.selectionEnd) return;
    sync(); const at = input.selectionStart;
    if (!at || !shouldDeleteSymbolPair(input.value[at - 1], input.value[at], pairs.some(pair => pair.from === at - 1 && pair.to === at + 1), options.preferences())) return;
    event.preventDefault(); event.stopImmediatePropagation(); input.setRangeText('', at - 1, at + 1, 'end'); sync(); emit(null, 'deleteContentBackward');
  });
  function finishComposition(typed?: string) {
    const saved = composition; if (!saved) return;
    const inserted = input.value.slice(saved.from, saved.from + 1);
    if ((typed !== undefined && typed !== inserted) || input.selectionStart !== saved.from + 1 || input.selectionEnd !== saved.from + 1 || input.value !== saved.value.slice(0, saved.from) + inserted + saved.value.slice(saved.to)) return;
    composition = null;
    transform(inserted, saved.from, saved.to, saved.value, saved.backward, saved.pairs, true);
  }
  input.addEventListener('compositionstart', () => { sync(); composing = true; composition = { value, from: input.selectionStart, to: input.selectionEnd, backward: input.selectionDirection === 'backward', pairs: pairs.slice() }; });
  input.addEventListener('compositionend', event => { composing = false; if (event.data.length === 1) finishComposition(event.data); else composition = null; });
  input.addEventListener('blur', () => { composition = null; composing = false; });
  return controller;
}
