import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { checkHtmlStylePolicy } from './test-html-style-policy';
import { createPreviewDocument } from '../src/export/previewDocument';
import exportRuntime from '../src/export/runtime';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { decodeInitMessage } from '../src/protocol/readyInit';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const fixture = `Before witness.

<section id="styled-box" style="border:3px solid #3b82f6;border-left:7px dashed #a855f7;border-radius:12px;padding:12px 16px;margin:8px auto;width:360px;max-width:95%;box-sizing:border-box;background:rgba(59,130,246,.12)">
<p id="styled-type" style="font-family:'Example; Family',serif;font-size:18px;font-weight:450;line-height:1.6;letter-spacing:.5px;word-spacing:2px;text-indent:1em;text-transform:uppercase;text-decoration:underline wavy #3b82f6 2px;text-underline-offset:3px;overflow-wrap:anywhere;tab-size:4">Document formatting</p>
<ul id="styled-list" style="list-style:square inside;padding-inline-start:20px"><li>First item</li><li>Second item</li></ul>
<table id="styled-table" style="border-collapse:separate;border-spacing:5px 7px;width:280px"><caption style="caption-side:bottom">Table caption</caption><tr><td style="border:1px solid #3b82f6;padding:4px">Cell A</td><td>Cell B</td></tr></table>
<img id="styled-image" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjEiIGZpbGw9IiMzYjgyZjYiLz48L3N2Zz4=" style="width:64px;height:32px;object-fit:cover;object-position:25% 75%;aspect-ratio:2/1;border-radius:4px">
<img id="styled-ratio-image" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIyIiBoZWlnaHQ9IjEiIGZpbGw9IiMzYjgyZjYiLz48L3N2Zz4=" style="width:48px;aspect-ratio:1;object-fit:cover;border-radius:6px">
</section>

<div id="empty-border" style="border:3px solid red;border-left:8px solid blue;border:2px dashed green;border-radius:8px;width:180px"></div>

<div id="empty-background" style="padding:8px;background:red;background-color:blue;background:rgba(59,130,246,.2);width:180px"></div>

<div id="width-only-border" style="border:3px"></div>

<div id="hidden-border" style="border:3px solid transparent"></div>

<div id="hidden-background" style="height:12px;background-color:red;background:transparent"></div>

<div style="visibility:hidden"><div id="reset-visibility" style="visibility:initial;border:1px solid #3b82f6;width:180px"></div></div>

<div style="font-size:0;color:transparent"><div id="reset-type" style="font-size:initial;color:initial">Reset inherited ink</div></div>

<div id="inline-padding" style="display:inline-block;padding:4px;background:rgba(59,130,246,.2)"></div>

After witness.
`;

async function frames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async count => { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame); }, count);
}

export async function checkHtmlStyleRendering(): Promise<void> {
  checkHtmlStylePolicy();
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const html = renderMarkdownToHtml({ markdownText: fixture, markdownFilePath: '/fixture/html-styles.md', target }).html;
    assert.match(html, /border:3px solid #3b82f6/); assert.match(html, /font-weight:450/);
    assert.match(html, /list-style:square inside/); assert.match(html, /object-fit:cover/);
    const unsafe = renderMarkdownToHtml({ markdownText: '<div style="border:expression(alert(1));padding:var(--vscode-editor-font-size);position:fixed;color:red !important">Safe</div>', markdownFilePath: '/fixture/html-styles.md', target }).html;
    assert.doesNotMatch(unsafe, /expression|var\(|position:|!important/);
  }
  const github = exportRuntime.renderPreviewDocument({ markdownText: '<div id="github-style" style="border:3px solid red;color:red;padding:12px">GitHub text</div>', sourceDocumentPath: '/fixture/html-styles.md', uiLanguage: 'en', preset: 'github-readme' });
  // The built-in GitHub preset has its own HTML compatibility policy.
  assert.doesNotMatch(github.html, /border:3px|color:red|padding:12px/);
  const build = await Bun.build({entrypoints:['scripts/test-preview-reading-surface-production-entry.ts'],target:'browser',format:'iife'});
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const bundle = await build.outputs[0]!.text();
  fs.mkdirSync('.local/html-style-audit', {recursive:true});
  const browser = await launchTestBrowser();
  let failure: unknown;
  try {
    for (const large of [false, true]) for (const surface of ['live', 'preview', 'source-preview'] as const) {
      for (const appearance of large ? ['light'] : ['light', 'dark']) {
        const page = await browser.newPage(), errors: string[] = [];
        const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
        let previewSource = '';
        page.on('pageerror', error => errors.push(String(error)));
        try {
          await page.setViewport({width:1200,height:900});
          await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
          await page.addStyleTag({path:'webview/src/styles.css'});
          await page.exposeFunction('__htmlStyleHost', async (message: any) => {
            if (message.type === 'requestPreviewDocument') return {type:'previewDocumentResult',requestId:message.requestId,documentId:message.documentId,
              result:{ok:true,value:await documents.get(message.documentId)!.run(message.operation)}};
            if (message.type !== 'requestPreviewRender') return null;
            previewSource = message.text;
            const options = {markdownText:message.text,sourceDocumentPath:'/fixture/html-styles.md',uiLanguage:message.uiLanguage,styleEnvironment:message.environment,preset:message.preset};
            const parsed = message.window ? createPreviewDocument(message.requestId, options) : undefined;
            if (parsed) documents.set(message.requestId, parsed);
            return {type:'previewRenderResult',requestId:message.requestId,result:{ok:true,value:parsed ? parsed.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options)}};
          });
          await page.addScriptTag({content:`window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__htmlStyleHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});`});
          await page.addScriptTag({content:bundle});
          const text = fixture + (large ? '\nUnchanged background paragraph with enough text to exceed the automatic large document threshold.\n'.repeat(15000) : '');
          assert.equal(assessLargeDocument(text).windowedPreview, large,
            'The paired fixtures must straddle the real Preview policy boundary');
          const init = {
            type:'init',documentId:'file:///html-styles.md',text,version:1,savedRevision:{version:1,text},diagnostics:[],
            mode:surface === 'source-preview' ? 'source' : surface,uiLanguage:appearance === 'dark' ? 'zh-CN' : 'en',
            editorAppearance:appearance,previewAppearance:appearance,sourceLineNumbers:'on',previewSourceColoring:false,previewFontFamily:'',previewShowComments:false,
            gitChangesGutter:false,gitDiffLineHighlights:false,gitDiffDetailsVisible:false,diffBaselineMode:'current-edit',
            fixedBaselinePinned:false,fixedBaselineActive:false,contentMaxWidthEnabled:false,largeDocumentOptimizationEnabled:true,
            findOptions:{wholeWord:false,caseSensitive:false},outlinePosition:'right',outlineVisible:false,outlineWidth:260,
            restoreReadingPositionOnOpen:false,vscodeTheme:null
          };
          assert.ok(decodeInitMessage(init), 'the HTML style harness must send a valid production init');
          await page.evaluate(data => window.dispatchEvent(new MessageEvent('message',{data})), init);
          await page.waitForFunction(() => !document.querySelector('.meo-preload-toolbar') && !document.querySelector('.mode-group [aria-busy="true"]'));
          if (surface === 'source-preview') {
            await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.source-preview-button')?.disabled);
            await page.click('.source-preview-button');
          }
          await page.waitForFunction(live => {
            const doc = live ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
            return Boolean(doc?.querySelector('#styled-box') && doc.querySelector('#empty-border') && doc.querySelector('#empty-background'));
          }, {}, surface === 'live');
          await frames(page, 12);
          if (surface !== 'live') assert.equal(documents.size > 0, large,
            'The production request must use the expected full or windowed Preview path');
          await page.waitForFunction(live => {
            const doc = live ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
            return ['styled-image','styled-ratio-image'].every(id => {
              const node = doc.getElementById(id)!;
              const image = (node.tagName === 'IMG' ? node : node.querySelector('img.meo-md-image-img')) as HTMLImageElement | null;
              return image?.complete && image.naturalWidth > 0;
            });
          },{},surface === 'live');
          const result = await page.evaluate(live => {
            const doc = live ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
            const style = (id: string) => doc.defaultView!.getComputedStyle(doc.getElementById(id)!);
            const actualImage = (id: string) => {
              const node = doc.getElementById(id)!;
              return (node.tagName === 'IMG' ? node : node.querySelector('img.meo-md-image-img')) as HTMLImageElement;
            };
            const box = style('styled-box'), type = style('styled-type'), table = style('styled-table'), image = doc.defaultView!.getComputedStyle(actualImage('styled-image')), border = style('empty-border');
            const ratioImage = actualImage('styled-ratio-image');
            (window as any).__htmlStyleNodes = {box:doc.getElementById('styled-box'),type:doc.getElementById('styled-type'),table:doc.getElementById('styled-table'),border:doc.getElementById('empty-border')};
            return {box:{border:box.borderTopWidth,left:box.borderLeftWidth,style:box.borderLeftStyle,radius:box.borderTopLeftRadius,padding:box.paddingTop,sizing:box.boxSizing},
              type:{family:type.fontFamily,weight:type.fontWeight,line:type.lineHeight,spacing:type.letterSpacing,decoration:type.textDecorationStyle,thickness:type.textDecorationThickness,wrap:type.overflowWrap},
              list:style('styled-list').listStyleType,table:{collapse:table.borderCollapse,spacing:table.borderSpacing,
                right:doc.getElementById('styled-table')!.getBoundingClientRect().right,
                containerRight:doc.getElementById('styled-box')!.getBoundingClientRect().right-parseFloat(box.borderRightWidth)-parseFloat(box.paddingRight)},
              image:{fit:image.objectFit,position:image.objectPosition,ratio:image.aspectRatio,radius:image.borderTopLeftRadius},
              ratioSize:{width:ratioImage.getBoundingClientRect().width,height:ratioImage.getBoundingClientRect().height},
              border:{width:border.borderLeftWidth,style:border.borderLeftStyle,color:border.borderLeftColor},background:style('empty-background').backgroundColor,
              reset: ['reset-visibility','reset-type','inline-padding'].map(id=>Boolean(doc.getElementById(id))),
              hidden:live ? ['width-only-border','hidden-border','hidden-background'].map(id=>Boolean(doc.getElementById(id))) : [],
              warnings:[...doc.querySelectorAll<HTMLElement>('.meo-md-html-warning:not([hidden])')].map(node=>node.dataset.tooltip)};
          }, surface === 'live');
          const label = `${large?'large':'small'}/${surface}/${appearance}`;
          assert.deepEqual(result.box,{border:'3px',left:'7px',style:'dashed',radius:'12px',padding:'12px',sizing:'border-box'},label);
          assert.match(result.type.family,/Example; Family/,label);
          assert.equal(result.type.weight,'450',label); assert.equal(result.type.line,'28.8px',label);
          assert.equal(result.type.spacing,'0.5px',label); assert.equal(result.type.decoration,'wavy',label);
          assert.equal(result.type.thickness,'2px',label); assert.equal(result.type.wrap,'anywhere',label);
          assert.equal(result.list,'square',label); assert.equal(result.table.collapse,'separate',label); assert.equal(result.table.spacing,'5px 7px',label);
          assert.ok(result.table.right <= result.table.containerRight+1,`${label}: nested HTML table overflowed the author's padded container`);
          assert.equal(result.image.fit,'cover',label); assert.equal(result.image.position,'25% 75%',label); assert.equal(result.image.ratio,'2 / 1',label);
          assert.equal(result.image.radius,'4px',label); assert.deepEqual(result.ratioSize,{width:48,height:48},label);
          assert.deepEqual(result.border,{width:'2px',style:'dashed',color:'rgb(0, 128, 0)'},label);
          assert.equal(result.background,'rgba(59, 130, 246, 0.2)',label);
          assert.deepEqual(result.reset,[true,true,true],label);
          if (surface === 'live') { assert.deepEqual(result.hidden,[false,false,false],label); assert.deepEqual(result.warnings,[],label); }
          if (surface !== 'live') assert.equal(previewSource,text,`${label}: Preview must receive the original source`);
          if (surface !== 'preview') assert.equal(await page.evaluate(() =>
            (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.doc.toString()),text,
          `${label}: filtering must not modify the editor document`);
          if (!large) await page.screenshot({path:`.local/html-style-audit/${surface}-${appearance}.png`});
          // A prose edit uses the same production adapter; unchanged HTML DOM must survive it.
          if (surface !== 'preview') {
            const from = text.indexOf('Before witness.') + 6;
            await page.evaluate(from => {
              const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
              view.dispatch({changes:{from,insert:'edit '},selection:{anchor:from+5},userEvent:'input.type'});
            }, from);
            await frames(page, 20);
            if (surface === 'source-preview') await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
              ?.contentDocument?.body.textContent?.includes('Beforeedit'));
            assert.ok(await page.evaluate(live => {
              const doc = live ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
              return Object.entries((window as any).__htmlStyleNodes).every(([key,node])=>node === doc.getElementById(({box:'styled-box',type:'styled-type',table:'styled-table',border:'empty-border'} as any)[key]));
            },surface === 'live'),`${label}: unrelated prose replaced HTML nodes`);
          }
          assert.deepEqual(errors,[],label);
          console.log(`PASS HTML styles ${label}: computed styles, empty paint, source preservation and unrelated DOM reuse`);
        } catch(error) {
          console.error('HTML style case failed', {large,surface,appearance,errors}, await page.evaluate(() => ({
            ids:[...document.querySelectorAll('[id]')].map(node=>node.id).filter(id=>/style|empty|hidden|border/.test(id)),
            html:[...document.querySelectorAll('.meo-md-html-content,.meo-md-html-invisible-source-text')].map(node=>node.outerHTML.slice(0,1500)),
            notice:document.querySelector('.meo-editor-notice')?.textContent,
            preview:document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.innerHTML.slice(0,1500)
          })));
          await page.screenshot({path:'.local/html-style-audit/failed.png'}); throw error;
        } finally { for (const doc of documents.values()) doc.dispose(); await page.close(); }
      }
    }
  } catch(error) { failure=error; throw error; }
  finally { if(failure===undefined)await closeTestBrowser(browser);else await closeTestBrowser(browser,failure); }
}

if(import.meta.main) await checkHtmlStyleRendering();
