import type { InputAssistance } from '../../../src/foundation/editingPreferences';
import { markdownCodeRanges } from './blockInsertion';
import { parser } from '@lezer/markdown';
import { planHtmlCommentToggle, planHtmlCommentInput, deleteEmptyHtmlComment } from '../application/htmlCommentInput';
import { planSymbolInput, shouldDeleteSymbolPair } from '../application/symbolInput';
import type { AutomaticSymbolPair } from './typingAssistance';

export interface NativeSymbolInput { readonly composing: boolean; snapshot(): readonly AutomaticSymbolPair[]; reset(): void; beginComment(from: number, to: number): void }
const controllers = new WeakMap<HTMLTextAreaElement, NativeSymbolInput>();
export const nativeSymbolInput = (input: HTMLTextAreaElement) => controllers.get(input);

function nativeCommentInCode(input: HTMLTextAreaElement): boolean {
  for (const position of [input.selectionStart, input.selectionEnd]) {
    for (let node = parser.parse(input.value).resolveInner(position, -1); node; node = node.parent!)
      if (/^(?:InlineCode|FencedCode|CodeBlock)$/.test(node.name)) return true;
  }
  return false;
}

export function planNativeHtmlCommentToggle(input: HTMLTextAreaElement, lines: boolean) {
  if (input.readOnly || input.disabled || controllers.get(input)?.composing || nativeCommentInCode(input)) return null;
  const selection = input.selectionDirection === 'backward' ? { anchor: input.selectionEnd, head: input.selectionStart } : { anchor: input.selectionStart, head: input.selectionEnd };
  return planHtmlCommentToggle(input.value, [selection], lines, markdownCodeRanges(parser.parse(input.value)));
}

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
  let comment: { from: number; to: number; end: number } | null = null;
  let composition: { value: string; from: number; to: number; backward: boolean; pairs: readonly AutomaticSymbolPair[] } | null = null;
  const valid = (pair: AutomaticSymbolPair) => pair.to > pair.from && input.value.slice(pair.from, pair.from + pair.open.length) === pair.open && input.value.slice(pair.to - pair.close.length, pair.to) === pair.close;
  const sync = () => {
    const next = input.value;
    if (epoch !== options.originEpoch()) { epoch = options.originEpoch(); value = next; pairs = options.readOrigins().slice(); composition = null; comment = null; return; }
    if (next === value) return;
    let from = 0, oldTo = value.length, newTo = next.length;
    while (from < oldTo && from < newTo && value[from] === next[from]) from++;
    while (oldTo > from && newTo > from && value[oldTo - 1] === next[newTo - 1]) { oldTo--; newTo--; }
    const map = (position: number, association: number) => position < from || position === from && association < 0 ? position : position > oldTo || position === oldTo && association > 0 ? position + newTo - oldTo : association < 0 ? from : newTo;
    pairs = pairs.map(pair => ({ ...pair, from: map(pair.from, 1), to: map(pair.to, -1) })).filter(valid);
    if (comment) comment = { from: map(comment.from, -1), to: map(comment.to, 1), end: map(comment.end, 1) };
    value = next;
  };
  const transform = (typed: string, from: number, to: number, previous: string, backward: boolean, origins: readonly AutomaticSymbolPair[], committed = false): boolean => {
    if (!committed && from === to) {
      const html = planHtmlCommentInput(previous, from, typed, options.preferences(), origins.some(pair => pair.to - pair.close.length === to && (typed !== '>' || pair.close === '-->')), typed === '-' && previous.slice(from - 3, from) === '<!-' ? markdownCodeRanges(parser.parse(previous)) : []);
      if (html && !nativeCommentInCode(input)) {
        input.setRangeText(html.insert, html.from, html.to, 'end'); sync();
        if (html.pair) { pairs.push(html.pair); controller.beginComment(html.caret, html.caret); }
        input.setSelectionRange(html.caret, html.caret); return true;
      }
    }
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
  const controller: NativeSymbolInput = { get composing() { return composing; }, snapshot() { sync(); return pairs.slice(); }, reset() { epoch = options.originEpoch(); value = input.value; pairs = options.readOrigins().slice(); composition = null; comment = null; }, beginComment(from, to) {
    sync(); comment = { from, to, end: to + 3 };
    if (!pairs.some(pair => pair.from === from - 4 && pair.to === to + 3)) pairs.push({ from: from - 4, to: to + 3, open: '<!--', close: '-->' });
  } };
  controllers.set(input, controller);
  input.addEventListener('focus', () => controller.reset());
  input.addEventListener('beforeinput', event => {
    if (input.readOnly || input.disabled || composing || event.isComposing || event.inputType !== 'insertText' || event.data?.length !== 1) return;
    sync();
    if (!transform(event.data, input.selectionStart, input.selectionEnd, input.value, input.selectionDirection === 'backward', pairs)) return;
    event.preventDefault(); emit(event.data, 'insertText');
  });
  input.addEventListener('input', () => {
    if (composition && !composing) finishComposition();
    sync();
  });
  const validateComment = () => {
    if (comment && (input.selectionStart < comment.from || input.selectionEnd > comment.to
      || input.value.slice(comment.from - 4, comment.from) !== '<!--' || input.value.slice(comment.to, comment.end) !== '-->')) comment = null;
  };
  input.addEventListener('select', validateComment);
  input.addEventListener('pointerup', validateComment);
  input.addEventListener('keydown', event => {
    if (input.readOnly || input.disabled) return;
    sync(); validateComment();
    if (comment && !composing && !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey && ['Tab', 'Escape'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Tab') input.setSelectionRange(comment.end, comment.end);
      comment = null; return;
    }
    if (composing || event.isComposing || event.key !== 'Backspace' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || input.selectionStart !== input.selectionEnd) return;
    sync(); const at = input.selectionStart;
    if (deleteEmptyHtmlComment(input.value, at, options.preferences(), pairs.some(pair => pair.from === at - 4 && pair.to === at + 3))) {
      event.preventDefault(); event.stopImmediatePropagation(); input.setRangeText('', at - 4, at + 3, 'end'); sync(); comment = null; emit(null, 'deleteContentBackward'); return;
    }
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
  input.addEventListener('blur', () => { composition = null; composing = false; comment = null; });
  return controller;
}
