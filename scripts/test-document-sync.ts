import { reconcileExternalDocument } from '../webview/src/helpers/documentSync';

const noDraft = reconcileExternalDocument('one\ntwo', null, 'one\nchanged');
if (noDraft.text !== 'one\nchanged' || noDraft.pendingText !== null) {
  throw new Error(`external update without draft was not accepted: ${JSON.stringify(noDraft)}`);
}

const disjoint = reconcileExternalDocument('one\ntwo', 'one\ntwo\nlocal', 'remote\none\ntwo');
if (disjoint.text !== 'remote\none\ntwo\nlocal' || disjoint.pendingText !== disjoint.text) {
  throw new Error(`disjoint local edit was not rebased: ${JSON.stringify(disjoint)}`);
}

const overlapping = reconcileExternalDocument('one\ntwo', 'one\nlocal', 'one\nremote');
if (overlapping.text !== 'one\nremote' || overlapping.pendingText !== null) {
  throw new Error(`overlapping external update did not win: ${JSON.stringify(overlapping)}`);
}

// A snapshot identical to the base (panel activation / save freshness echo)
// predates the local draft and must not discard pending keystrokes.
const staleEcho = reconcileExternalDocument('one\ntwo', 'one\ntwo\nlocal', 'one\ntwo');
if (staleEcho.text !== 'one\ntwo\nlocal' || staleEcho.pendingText !== staleEcho.text) {
  throw new Error(`stale echo snapshot discarded the local draft: ${JSON.stringify(staleEcho)}`);
}

const staleEchoDelete = reconcileExternalDocument('one\ntwo', 'one', 'one\ntwo');
if (staleEchoDelete.text !== 'one' || staleEchoDelete.pendingText !== 'one') {
  throw new Error(`stale echo snapshot discarded a local deletion: ${JSON.stringify(staleEchoDelete)}`);
}

console.log('document sync reconciliation checks passed');
