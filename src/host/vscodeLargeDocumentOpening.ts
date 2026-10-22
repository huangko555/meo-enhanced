import * as vscode from 'vscode';

export const LARGE_DOCUMENT_SOURCE_OPENING_SETTING_KEY = 'performance.largeDocumentOptimization';

const DEFAULT_OFF_MIGRATION_KEY = 'largeDocumentSourceOpeningDefaultOffMigration';

/** Retires the old opening workaround once per profile/workspace, before any panel opens. */
export async function migrateLargeDocumentOpening(context: {
  readonly globalState: Pick<vscode.Memento, 'get' | 'update'>;
  readonly workspaceState: Pick<vscode.Memento, 'get' | 'update'>;
}): Promise<void> {
  // This is a window-scoped setting. Each workspace can still contain an old
  // override after its profile migrated; later explicit choices must survive.
  for (const [target, state, scope] of [
    [vscode.ConfigurationTarget.Global, context.globalState, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, context.workspaceState, 'workspaceValue']
  ] as const) {
    if (state.get(DEFAULT_OFF_MIGRATION_KEY) === true) continue;
    const configuration = vscode.workspace.getConfiguration('meoEnhanced');
    if (configuration.inspect<boolean>(LARGE_DOCUMENT_SOURCE_OPENING_SETTING_KEY)?.[scope] === true) {
      await configuration.update(LARGE_DOCUMENT_SOURCE_OPENING_SETTING_KEY, false, target);
    }
    // An unsuccessful settings write must retry on the next activation.
    await state.update(DEFAULT_OFF_MIGRATION_KEY, true);
  }
}
