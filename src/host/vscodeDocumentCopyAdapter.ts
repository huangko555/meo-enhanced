import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DocumentCopyResponse, SaveDocumentCopyRequest } from '../protocol/documentCopy';

export type VscodeDocumentCopyAdapter = {
  handle(request: SaveDocumentCopyRequest): Promise<DocumentCopyResponse>;
  dispose(): void;
};

export function createVscodeDocumentCopyAdapter(
  sourceUri: vscode.Uri,
  options: {
    readonly getUiLanguage: () => 'en' | 'zh-CN';
    readonly onSaved: (uri: vscode.Uri) => void;
    readonly onFailure: (message: string) => void;
  }
): VscodeDocumentCopyAdapter {
  const requests = new Map<string, Promise<DocumentCopyResponse>>();
  let active = false;
  let disposed = false;
  const label = (english: string, chinese: string): string => (
    options.getUiLanguage() === 'zh-CN' ? chinese : english
  );

  const errorResponse = (requestId: string, message: string): DocumentCopyResponse => ({
    type: 'documentCopyResult',
    requestId,
    result: { ok: false, error: { code: 'operation-failed', message } }
  });

  const save = async (request: SaveDocumentCopyRequest): Promise<DocumentCopyResponse> => {
    const originalName = path.posix.basename(sourceUri.path) || 'document.md';
    const originalExtension = path.posix.extname(originalName);
    const extension = originalExtension || '.md';
    const stem = originalName.slice(0, originalName.length - originalExtension.length);
    const defaultUri = sourceUri.scheme === 'file'
      ? vscode.Uri.joinPath(sourceUri, '..', stem + '-copy' + extension)
      : undefined;
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: label('Save Copy', '另存副本'),
      filters: { Markdown: ['md', 'markdown', 'txt'] }
    });
    if (!destination) return {
      type: 'documentCopyResult',
      requestId: request.requestId,
      result: { ok: true, value: { status: 'cancelled' } }
    };
    if (disposed) return errorResponse(request.requestId,
      label('The editor closed before the copy could be saved.', '编辑器已关闭，副本尚未保存。'));

    const sourcePath = process.platform === 'win32' ? sourceUri.fsPath.toLowerCase() : sourceUri.fsPath;
    const destinationPath = process.platform === 'win32' ? destination.fsPath.toLowerCase() : destination.fsPath;
    const samePath = sourceUri.scheme === 'file' && destination.scheme === 'file'
      ? sourcePath === destinationPath
      : sourceUri.toString() === destination.toString();
    if (samePath) throw new Error(label(
      'Choose a different filename; a copy cannot replace the current document.',
      '请选择其他文件名；副本不能覆盖当前文档。'
    ));

    try {
      await vscode.workspace.fs.stat(destination);
      throw new Error(label(
        'The selected file already exists. Choose a new filename for the copy.',
        '目标文件已存在，请为副本选择新文件名。'
      ));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT') throw error;
    }

    const bytes = new TextEncoder().encode(request.text);
    await vscode.workspace.fs.writeFile(destination, bytes);
    let confirmed: Uint8Array;
    try {
      confirmed = await vscode.workspace.fs.readFile(destination);
    } catch {
      throw new Error(label('The copy was written to ', '副本已写入 ') +
        (destination.fsPath || destination.toString()) +
        label(', but could not be verified. The original editor remains unchanged.',
          '，但无法核验。原编辑器内容未改变。'));
    }
    if (confirmed.length !== bytes.length || confirmed.some((byte, index) => byte !== bytes[index])) {
      throw new Error(label('The copy at ', '副本 ') +
        (destination.fsPath || destination.toString()) +
        label(' did not match the editor content. The original editor remains unchanged.',
          ' 与编辑器内容不一致。原编辑器内容未改变。'));
    }
    try { options.onSaved(destination); } catch { /* Feedback cannot undo a verified copy. */ }
    return {
      type: 'documentCopyResult',
      requestId: request.requestId,
      result: { ok: true, value: { status: 'saved' } }
    };
  };

  return {
    handle(request) {
      const existing = requests.get(request.requestId);
      if (existing) return existing;
      if (disposed) return Promise.resolve(errorResponse(request.requestId,
        label('The editor is closed.', '编辑器已关闭。')));
      if (active) return Promise.resolve(errorResponse(request.requestId,
        label('Another document copy is already in progress.', '另一项另存副本操作仍在进行。')));
      active = true;
      const operation = save(request).catch((error): DocumentCopyResponse => {
        const message = error instanceof Error ? error.message
          : label('Could not save the document copy.', '无法保存文档副本。');
        try { options.onFailure(message); } catch { /* Keep the correlated failure response. */ }
        return errorResponse(request.requestId, message);
      }).finally(() => { active = false; });
      requests.set(request.requestId, operation);
      while (requests.size > 16) {
        const oldest = requests.keys().next().value;
        if (typeof oldest !== 'string') break;
        requests.delete(oldest);
      }
      return operation;
    },
    dispose() {
      disposed = true;
      requests.clear();
    }
  };
}