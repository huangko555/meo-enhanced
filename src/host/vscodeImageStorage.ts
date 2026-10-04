import * as vscode from 'vscode';
import { decodeImageStorage } from '../foundation/imageStorage';
import { createImageStorageHost, type ImageStorageContext } from './imageStorage';

export function readVscodeImageStorage(uri: vscode.Uri): ImageStorageContext {
  const config = vscode.workspace.getConfiguration('meoEnhanced', uri);
  const legacy = config.inspect<string>('imageFolder');
  const configuredFolder = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
  const value = config.get<unknown>('imageStorage');
  const imageStorage = value == null ? undefined : decodeImageStorage(value);
  if (imageStorage === null) throw new Error('Invalid imageStorage configuration.');
  return { documentFsPath: uri.scheme === 'file' ? uri.fsPath : null,
    workspaceFsPath: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath, configuredFolder,
    ...(imageStorage ? { imageStorage } : {}) };
}

export function createVscodeImageStorage() {
  return createImageStorageHost({
    read: resource => readVscodeImageStorage(vscode.Uri.parse(resource)),
    write: async (resource, preferences) => {
      const config = vscode.workspace.getConfiguration('meoEnhanced', vscode.Uri.parse(resource));
      const current = config.inspect('imageStorage');
      const legacy = config.inspect('imageFolder');
      const existing = current?.workspaceFolderValue != null || current?.workspaceValue != null || current?.globalValue != null ? current : legacy;
      const target = existing?.workspaceFolderValue !== undefined && existing.workspaceFolderValue !== null ? vscode.ConfigurationTarget.WorkspaceFolder
        : existing?.workspaceValue !== undefined && existing.workspaceValue !== null ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('imageStorage', preferences, target);
    },
    selectFolder: async (resource, initialDirectory) => {
      const uri = vscode.Uri.parse(resource);
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        defaultUri: initialDirectory ? vscode.Uri.file(initialDirectory) : uri.scheme === 'file' ? vscode.Uri.joinPath(uri, '..') : undefined,
        openLabel: vscode.env.language.startsWith('zh') ? '选择图片文件夹' : 'Select image folder'
      });
      return selected?.[0]?.scheme === 'file' ? selected[0].fsPath : null;
    }
  });
}
