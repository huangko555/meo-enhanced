import { spawn } from 'node:child_process';

export function openWindowsFile(fsPath: string): Promise<void> {
  // Bundling `open` embeds its build checkout URL; invoke the Windows shell without it.
  const command = `Start-Process -FilePath '${fsPath.replaceAll("'", "''")}'`;
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand
    ], { windowsVerbatimArguments: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
