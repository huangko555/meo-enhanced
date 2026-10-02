import * as vscode from 'vscode';
import { createEditingPreferencesHost, EDITING_PREFERENCES_SETTING } from './editingPreferences';

export function createVscodeEditingPreferences() {
  return createEditingPreferencesHost({
    platform: process.platform === 'darwin' ? 'mac' : 'other',
    read: () => vscode.workspace.getConfiguration('meoEnhanced').get(EDITING_PREFERENCES_SETTING),
    write: async preferences => {
      const configuration = vscode.workspace.getConfiguration('meoEnhanced');
      const inspected = configuration.inspect(EDITING_PREFERENCES_SETTING);
      const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update(EDITING_PREFERENCES_SETTING, preferences, target);
    }
  });
}
