import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { createEditor } from './test-editor-factory';

(globalThis as typeof globalThis & {
  ListEditingHarness?: {
    createEditor: typeof createEditor;
    userEvent: typeof Transaction.userEvent;
    isolateHistory: typeof isolateHistory;
  };
}).ListEditingHarness = {
  createEditor,
  userEvent: Transaction.userEvent,
  isolateHistory
};
