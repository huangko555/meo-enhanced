import { Language } from '@codemirror/language';
import type { StateEffect, StateEffectType } from '@codemirror/state';

// CodeMirror publishes background parsing through an internal effect. Keep that
// version boundary here: unknown effects must never inherit this exemption.
// If the dependency removes it, fall back to normal presentation invalidation.
const publication = (Language as unknown as {
  readonly setState?: StateEffectType<unknown>;
}).setState;

export function isCodeMirrorSyntaxPublicationEffect(effect: StateEffect<unknown>): boolean {
  return publication !== undefined && effect.is(publication);
}
