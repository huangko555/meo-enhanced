import { createEditor } from './test-editor-factory';
import { Transaction } from '@codemirror/state';
import { getDetailsBlocks, toggleDetailsBlock } from '../webview/src/helpers/detailsBlocks';

(window as typeof window & {
  __createInputCursorEditor?: typeof createEditor;
  __dispatchProductionInput?: (editor: ReturnType<typeof createEditor>, from: number, insert: string, to?: number) => void;
  __toggleFirstDetails?: (editor: ReturnType<typeof createEditor>) => boolean;
}).__createInputCursorEditor = createEditor;

(window as typeof window & {
  __dispatchProductionInput?: (editor: ReturnType<typeof createEditor>, from: number, insert: string, to?: number) => void;
}).__dispatchProductionInput = (editor, from, insert, to = from) => {
  editor.view.dispatch({
    changes: { from, to, insert },
    annotations: Transaction.userEvent.of('input.type')
  });
};

(window as typeof window & {
  __toggleFirstDetails?: (editor: ReturnType<typeof createEditor>) => boolean;
}).__toggleFirstDetails = (editor) => {
  const block = getDetailsBlocks(editor.view.state)[0];
  return block ? toggleDetailsBlock(editor.view, block.anchorFrom) : false;
};
