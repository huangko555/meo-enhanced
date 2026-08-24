import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { createEditor } from './test-editor-factory';
import { installCausalFrameSettlement } from './causal-frame-settlement';
import {
  getTableTransactionProvenance
} from '../webview/src/adapters/tableTransactionProvenance';

(globalThis as typeof globalThis & {
  ListEditingHarness?: {
    createEditor: typeof createEditor;
    userEvent: typeof Transaction.userEvent;
    addToHistory: typeof Transaction.addToHistory;
    isolateHistory: typeof isolateHistory;
    getTableTransactionProvenance: typeof getTableTransactionProvenance;
    installCausalFrameSettlement: typeof installCausalFrameSettlement;
  };
}).ListEditingHarness = {
  createEditor,
  userEvent: Transaction.userEvent,
  addToHistory: Transaction.addToHistory,
  isolateHistory,
  getTableTransactionProvenance,
  installCausalFrameSettlement
};
