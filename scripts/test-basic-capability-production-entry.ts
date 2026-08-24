import { createEditor } from './test-editor-factory';
import { createSelectionMenu, createSelectionMenuController } from '../webview/src/helpers/selectionMenu';

type Editor = ReturnType<typeof createEditor>;

export function createBasicCapabilityEditor(options: Parameters<typeof createEditor>[0]) {
  let editor: Editor | null = null;
  const elements = createSelectionMenu();
  document.body.append(elements.menu);
  const controller = createSelectionMenuController(elements, () => editor);
  elements.menu.addEventListener('pointerdown', (event) => event.preventDefault());
  elements.menu.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('.selection-inline-button');
    if (button?.dataset.action) controller.handleAction(button.dataset.action);
  });
  editor = createEditor({
    ...options,
    onSelectionChange: (state) => {
      controller.update(state);
      options.onSelectionChange?.(state);
    }
  });

  return {
    editor,
    menu: elements.menu,
    dispose() {
      editor?.destroy();
      elements.menu.remove();
    }
  };
}

(globalThis as typeof globalThis & {
  BasicCapabilityProductionHarness?: { createBasicCapabilityEditor: typeof createBasicCapabilityEditor };
}).BasicCapabilityProductionHarness = { createBasicCapabilityEditor };
