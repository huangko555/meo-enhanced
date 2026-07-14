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

console.log('document sync reconciliation checks passed');
