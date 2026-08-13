import assert from 'node:assert/strict';
import { mock } from 'bun:test';

const documentUri = { toString: () => 'file:///notes.md' };
const diagnostics = [{
  range: { start: 0, end: 5 },
  severity: 0,
  message: 'Compiler error',
  source: 'TypeScript',
  code: { value: 2322 }
}];

mock.module('vscode', () => ({
  languages: {
    getDiagnostics: (uri: unknown) => {
      assert.equal(uri, documentUri);
      return diagnostics;
    }
  }
}));

const { createVscodeDiagnosticsAdapter } = await import('../src/host/vscodeDiagnosticsAdapter');
const document = {
  uri: documentUri,
  getText: () => 'error\r\nnext',
  offsetAt: (position: number) => position
};

assert.deepEqual(createVscodeDiagnosticsAdapter(document as never).read(), [{
  from: 0,
  to: 5,
  severity: 0,
  message: 'Compiler error',
  source: 'TypeScript',
  code: '2322'
}], 'VS Code/compiler diagnostics must remain serialized without creating MEO diagnostics');

console.log('VS Code diagnostics adapter checks passed');
