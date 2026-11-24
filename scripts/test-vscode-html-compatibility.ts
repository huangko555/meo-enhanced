import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { resolveExportHtmlStyles } from '../src/export/htmlStyles';
import { htmlCompatibilityParityCases } from './html-compatibility-cases';
import { htmlCompatibilityImage } from './html-compatibility-fixture';

const codeIndex = process.argv.indexOf('--code');
const code = process.argv[codeIndex + 1];
assert.ok(codeIndex >= 0 && code && fs.existsSync(code), 'Pass --code <Code executable>');
const output = fs.mkdtempSync(path.resolve('.local/html-compatibility-native-'));
const workspace = path.join(output,'workspace');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(output,'profile','User'),{recursive:true});
fs.mkdirSync(path.join(output,'extensions'));
fs.writeFileSync(path.join(output,'profile','User','settings.json'),JSON.stringify({
  'workbench.startupEditor':'none','telemetry.telemetryLevel':'off','git.enabled':false,'update.mode':'none'
}));
const markdown = [
  'First paragraph.',
  '<a href="#audit-link-target" title="A > B">HTML link label</a> · <kbd title="A > B">Ctrl</kbd>',
  '<div id="audit-link-target">Native fragment target.</div>',
  ...htmlCompatibilityParityCases.map(item => item.source)
].join('\n\n');
fs.writeFileSync(path.join(workspace,'audit.md'),markdown);
fs.writeFileSync(path.join(workspace,'效果演示.css'),'#audit-linked{color:rgb(12,34,56)}');
fs.writeFileSync(path.join(workspace,'imported.css'),'#audit-imported{color:rgb(21,43,65)}');
fs.writeFileSync(path.join(workspace,'pixel.png'),Buffer.from(htmlCompatibilityImage.split(',')[1]!,'base64'));
fs.copyFileSync('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',path.join(workspace,'audit.woff2'));
const options = { markdownFilePath:path.join(workspace,'audit.md'),target:'html' as const };
const html = await resolveExportHtmlStyles(renderMarkdownToHtml({markdownText:markdown,...options}).html,options);
fs.writeFileSync(path.join(output,'fixture.json'),JSON.stringify({cases:htmlCompatibilityParityCases,html}));
const port = await new Promise<number>((resolve,reject) => {
  const reservation=createServer();
  reservation.once('error',reject);
  reservation.listen(0,'127.0.0.1',() => {
    const address=reservation.address();
    assert.ok(address && typeof address === 'object');
    reservation.close(error => error ? reject(error) : resolve(address.port));
  });
});
const env = {...process.env,MEO_HTML_COMPAT_OUTPUT:output,MEO_HTML_COMPAT_BROWSER_URL:`http://127.0.0.1:${port}`};
delete env.ELECTRON_RUN_AS_NODE;
const stdout = fs.openSync(path.join(output,'stdout.log'),'w');
const stderr = fs.openSync(path.join(output,'stderr.log'),'w');
try {
  const child = spawn(code,[
    '--new-window','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',
    `--remote-debugging-port=${port}`,`--user-data-dir=${path.join(output,'profile')}`,`--extensions-dir=${path.join(output,'extensions')}`,
    `--extensionDevelopmentPath=${path.resolve('.')}`,`--extensionTestsPath=${path.resolve('scripts/test-vscode-html-compatibility.cjs')}`,workspace
  ],{env,windowsHide:true,stdio:['ignore',stdout,stderr]});
  const exit = await new Promise<number | null>((resolve,reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native HTML compatibility timed out')); },300_000);
    child.once('error',error => {clearTimeout(timer);reject(error);});
    child.once('exit',code => {clearTimeout(timer);resolve(code);});
  });
  const report = JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8'));
  console.log(JSON.stringify({report:path.join(output,'result.json'),...report},null,2));
  assert.equal(exit,0); assert.equal(report.passed,true,report.error);
} finally { fs.closeSync(stdout);fs.closeSync(stderr); }
