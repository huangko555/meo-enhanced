import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeHtmlStylesheet } from '../src/shared/htmlStyle';
import { resolveHtmlStyleResources, htmlFontFaceName } from '../src/shared/htmlStyleResources';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { resolveExportHtmlStyles, createHtmlStyleResources } from '../src/export/htmlStyles';
import { htmlCompatibilityImage } from './html-compatibility-fixture';
import { decodeResolveHtmlStylesRequest, decodeResolvedHtmlStylesResponse } from '../src/protocol/htmlStyles';
import { initializeHtmlStyles, resolveHtmlStyles, acceptHtmlStyles } from '../webview/src/adapters/htmlStylesTransport';

export const htmlStyleResourceFixture = `
<style>#compat-order{color:rgb(1,2,3)}</style>

<link rel="stylesheet"href="样式/效果 演示.css">

<p id="compat-order">Stylesheet order</p>

<p id="compat-external" style="background-image:url(样式/images/pixel.png);transform:translateX(7px);overflow:auto;width:220px;height:40px"><span style="display:block;height:100px">External resources</span></p>

<ol id="compat-alpha" type="A"><li>Alphabetic list</li></ol>

<p id="compat-modern" style="font:italic 18px serif;writing-mode:vertical-rl;filter:grayscale(1);color:oklch(60% .15 30)"><custom-box id="compat-custom">Static content</custom-box></p>
`;
const font = `data:font/woff2;base64,${fs.readFileSync('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2').toString('base64')}`;
const styles = new Map([
  ['样式/效果 演示.css', '@import "../shared.css"; @font-face{font-family:"Resource Font";src:url(../fonts/main.woff2)} #compat-order{color:rgb(2,3,4)} #compat-external{--font-name:"Resource Font";--font-choice:var(--font-name);font-family:var(--font-choice)}'],
  ['shared.css', '@import "样式/效果 演示.css"; @layer resources{#compat-external{color:rgb(16,78,112)!important}#compat-external::before{content:"Loaded "}}'],
  ['样式/updated.css', '#compat-external{color:rgb(90,30,140)}'],
  ['样式/alternate.css', '#compat-external{color:rgb(30,90,140)}'],
]);

export async function resolveFixtureHtmlStyles(css: string): Promise<string> {
  return resolveHtmlStyleResources(css, {
    resolve: (url, base) => new URL(url, base ?? 'file:///fixture/html-styles.md').href,
    async read(url) {
      const key = decodeURIComponent(new URL(url).pathname).replace(/^\/fixture\//, '');
      const source = styles.get(key);
      if (source === undefined) throw new Error('Missing stylesheet fixture');
      return { css: sanitizeHtmlStylesheet(source), url };
    },
    async asset(url) {
      if (url.endsWith('/empty-background.png') && url !== 'https://example.invalid/empty-background.png') return '';
      return url.endsWith('.woff2') ? font : htmlCompatibilityImage;
    }
  });
}

export async function checkHtmlStyleResources(): Promise<void> {
  assert.ok(decodeResolveHtmlStylesRequest({type:'resolveHtmlStyles',requestId:'x',css:''}));
  assert.equal(decodeResolveHtmlStylesRequest({type:'resolveHtmlStyles',requestId:'',css:''}),null);
  assert.equal(decodeResolvedHtmlStylesResponse({type:'resolvedHtmlStyles',requestId:'x',result:{ok:true,value:{css:4}}}),null);
  const requests: import('../src/protocol/htmlStyles').ResolveHtmlStylesRequest[] = [];
  initializeHtmlStyles(message => requests.push(message));
  const cancelled = new AbortController(), pending = resolveHtmlStyles('x{color:red}',cancelled.signal);
  cancelled.abort(); assert.equal(await pending,null);
  acceptHtmlStyles({type:'resolvedHtmlStyles',requestId:requests[0]!.requestId,result:{ok:true,value:{css:'stale'}}});
  const empty = resolveHtmlStyles('x{color:red}',new AbortController().signal);
  acceptHtmlStyles({type:'resolvedHtmlStyles',requestId:requests[1]!.requestId,result:{ok:true,value:{css:''}}});
  assert.equal(await empty,'','A successfully empty stylesheet differs from unavailable IO');
  const root = fs.mkdtempSync(path.resolve('.local/html-style-resource-'));
  try {
    fs.mkdirSync(path.join(root, '样式', 'images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'fonts'));
    for (const [name, css] of styles) fs.writeFileSync(path.join(root, name), css);
    fs.copyFileSync('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', path.join(root, 'fonts/main.woff2'));
    fs.writeFileSync(path.join(root, '样式/images/pixel.png'), Buffer.from(htmlCompatibilityImage.split(',')[1]!, 'base64'));
    for (const target of ['html','pdf','docx'] as const) {
      const options = {markdownFilePath:path.join(root,'sample.md'),target,outputFilePath:path.join(root,'output.html')};
      const rendered = renderMarkdownToHtml({markdownText:htmlStyleResourceFixture,...options});
      const html = await resolveExportHtmlStyles(rendered.html, options);
      assert.match(html,/rgb\(16,78,112\)/);
      assert.match(html,/content:"Loaded "/);
      assert.match(html,new RegExp(htmlFontFaceName('Resource Font')));
      assert.doesNotMatch(html,/@meo-import/,'cyclic imports must terminate');
      assert.match(html,target === 'pdf' ? /file:\/\// : /data:font\/woff2;base64/);
      assert.match(html,target === 'pdf' ? /pixel.png/ : /data:image\/png;base64/);
    }
    const disabled = renderMarkdownToHtml({markdownText:'<link rel="stylesheet" href="missing.css" disabled>\n\n<p>Body</p>',markdownFilePath:path.join(root,'sample.md'),target:'html'}).html;
    assert.doesNotMatch(disabled,/@meo-import/);
    const safe = await resolveFixtureHtmlStyles(sanitizeHtmlStylesheet('@import "http://example.invalid/a.css";p{background:url(javascript:alert(1));color:red!important}'));
    assert.doesNotMatch(safe,/http:|javascript:/);
    assert.match(safe,/color:red!important/);
    const fromCss = await resolveFixtureHtmlStyles(sanitizeHtmlStylesheet('@import "样式/效果 演示.css";'));
    assert.match(fromCss,/data:font\/woff2;base64/);
    assert.match(fromCss,/meo-html-font-/);
    const conditional = await resolveFixtureHtmlStyles(sanitizeHtmlStylesheet('@import "shared.css" layer(imported) supports(display:grid) screen;'));
    assert.match(conditional,/@layer imported/); assert.match(conditional,/@supports \(display:grid\)/); assert.match(conditional,/@media screen/);
    const escaped = renderMarkdownToHtml({markdownText:'<link rel="stylesheet" href="x&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',markdownFilePath:path.join(root,'sample.md'),target:'html'}).html;
    assert.doesNotMatch(escaped,/<script>|@meo-import/);
    const staticHtml = renderMarkdownToHtml({markdownText:'<div><dialog open>Dialog</dialog><font face="serif" color="red">Text</font><map name="m"><area href="#x" coords="0,0,1,1" shape="rect"></map><svg><defs><filter id="blur"><feGaussianBlur stdDeviation="1"/></filter></defs><rect filter="url(#blur)"/></svg></div>',markdownFilePath:path.join(root,'sample.md'),target:'html'}).html;
    for (const tag of ['dialog','font','map','area','filter','feGaussianBlur']) assert.ok(staticHtml.includes('<' + tag),tag);
    assert.match(staticHtml,/stdDeviation="1"/); assert.match(staticHtml,/filter="url\(#blur\)"/);
    const inline = renderMarkdownToHtml({markdownText:'Inline <link rel="stylesheet" href="inline.css"> stylesheet.\n\n<p>Body</p>',markdownFilePath:path.join(root,'sample.md'),target:'html'}).html;
    assert.match(inline,/@meo-import "inline.css"/);
    assert.doesNotMatch(inline,/<link/);
    const originalFetch = globalThis.fetch, requests: string[] = [];
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input); requests.push(url);
        if (url.endsWith('/start.css')) return new Response(null,{status:302,headers:{location:'/theme/main.css'}});
        if (url.endsWith('/bad.css')) return new Response(null,{status:302,headers:{location:'http://styles.invalid/insecure.css'}});
        return new Response('#remote{background-image:url(../image.png);color:red}');
      }) as typeof fetch;
      const resources = createHtmlStyleResources({markdownFilePath:path.join(root,'sample.md'),target:'html'});
      const remote = await resolveHtmlStyleResources(sanitizeHtmlStylesheet('@import "https://styles.invalid/start.css";'),resources);
      assert.match(remote,/https:\/\/styles.invalid\/image.png/,'Relative URLs use the final HTTPS stylesheet URL');
      const blocked = await resolveHtmlStyleResources(sanitizeHtmlStylesheet('@import "https://styles.invalid/bad.css";'),resources);
      assert.equal(blocked,'');
      assert.equal(requests.some(url => url.startsWith('http:')),false,'HTTP redirects must be rejected before fetching');
    } finally { globalThis.fetch = originalFetch; }
    console.log('HTML stylesheet resources: Chinese/spaced paths, nested/cyclic imports, fonts, assets, filtering and export targets passed');
  } finally {
    assert.ok(root.startsWith(path.resolve('.local') + path.sep));
    fs.rmSync(root, {recursive:true,force:true});
  }
}
