import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { getMermaidPalette } from '../src/shared/mermaidPalette';
import { assertReadableMermaidTasks } from './mermaid-contrast-helpers';
import { complexMermaidSamples } from './fixtures/mermaid-community-samples';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const flow = `flowchart TD
  subgraph review[资料审核]
    A[提交资料] --> B{信息完整？}
    B -->|补充| A
    B -->|通过| C[复核内容]
  end
  C --> D{可以归档？}
  D -->|退回| A
  D -->|确认| E[归档记录]
  A --> F[记录过程]
  F --> E`;
const diagrams = [flow, `---\nconfig:\n  layout: dagre\n---\n${flow}`,
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ ITEM : contains\n  CUSTOMER { string name "客户名称" }\n  ORDER { int number "订单编号" }',
  complexMermaidSamples.find(sample => sample.id === 'sequence')!.source,
  'stateDiagram-v2\n  [*] --> Editing\n  Editing --> Rendering\n  Rendering --> Editing\n  Rendering --> [*]',
  'classDiagram\n  Document <|-- Markdown\n  Document : +String content\n  Markdown : +render()',
  complexMermaidSamples.find(sample => sample.id === 'pie')!.source,
  'mindmap\n  root((文档))\n    编辑\n      源码\n      预览\n    导出',
  'gantt\n  dateFormat YYYY-MM-DD\n  section 状态\n  完成 :done, a, 2026-10-01, 3d\n  进行 :active, b, after a, 4d\n  普通 :c, after b, 3d\n  这是放在短任务条外面的完成标签 :done, outside, after c, 1d',
  '---\nconfig:\n  themeVariables:\n    doneTaskBkgColor: "#ffdab9"\n    taskTextDarkColor: "#241208"\n---\ngantt\n  dateFormat YYYY-MM-DD\n  section 自定义\n  作者颜色 :done, custom, 2026-10-01, 5d',
  'flowchart LR\n  A[自定义颜色] --> B[保留作者样式]\n  classDef custom fill:#ffdab9,stroke:#8c4a2f,color:#241208\n  class A custom\n  linkStyle 0 stroke:#8c4a2f'
];
const runtime = fs.readFileSync(path.resolve(import.meta.dir, '../webview/dist/mermaid.min.js'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const unexpectedRequests: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://meo-runtime.test/mermaid.min.js') {
      void request.respond({ status: 200, contentType: 'text/javascript', body: runtime });
    } else if (/^https?:/.test(request.url())) {
      unexpectedRequests.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  for (const target of ['html', 'pdf', 'docx'] as const) {
    for (const appearance of ['light', 'dark'] as const) {
      const document = await exportRuntime.renderExportHtmlDocument({
        readingSnapshot: {
          snapshotId: `mermaid-${target}-${appearance}`,
          text: diagrams.map(source => `\`\`\`mermaid\n${source}\n\`\`\``).join('\n\n'),
          appearance, uiLanguage: 'en', environment: { previewFontFamily: '' }
        },
        sourceDocumentPath: 'C:/tmp/mermaid-layout.md', outputFilePath: `C:/tmp/diagram.${target}`,
        target, mermaidRuntimeSrc: 'https://meo-runtime.test/mermaid.min.js',
        baseHref: 'file:///C:/tmp/', title: 'Mermaid compatibility', includeTableOfContents: false,
        shikiLanguageAssetsRoot: path.resolve(import.meta.dir, '../webview/dist')
      });
      const html = document.htmlDocument.replace('<script data-meo-export-runtime>', `<script>
        (()=>{
        const realInitialize=window.mermaid.initialize.bind(window.mermaid);
        window.mermaid.initialize=config=>{window.__exportMermaidConfig=config;return realInitialize(config)};
        })();
      </script><script data-meo-export-runtime>`);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true).catch(async error => {
        throw new Error(`Export not ready (${target}/${appearance}): ${JSON.stringify({ pageErrors, state: await page.evaluate(() => ({ error: (window as any).__MEO_EXPORT_ERROR__, blocks: document.querySelectorAll('.meo-export-mermaid svg').length })) })}`, { cause: error });
      });
      const result = await page.evaluate(async flow => {
        const blocks = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-mermaid'));
        const runtime = (window as any).mermaid;
        const geometry = (svg: Element) => ({
          edges: Array.from(svg.querySelectorAll('path.flowchart-link')).map(edge => edge.getAttribute('d')).sort(),
          nodes: Array.from(svg.querySelectorAll('g.node')).map(node => node.getAttribute('transform')).sort()
        });
        const config = (window as any).__exportMermaidConfig;
        const references: any[] = [];
        for (const layout of ['elk', 'dagre']) {
          runtime.initialize({ ...config, layout, look: 'classic', theme: 'base' });
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
          document.body.append(host);
          try {
            const rendered = await runtime.render(`reference-${layout}`, flow, host);
            host.innerHTML = rendered.svg;
            references.push(geometry(host.querySelector('svg')!));
          } finally { host.remove(); }
        }
        const svg = blocks[0]!.querySelector('svg')!;
        const custom = blocks.at(-1)!.querySelector('g.node .label-container');
        return {
          rendered: blocks.map(block => Boolean(block.querySelector('svg')) && !block.classList.contains('is-error')),
          errors: blocks.map(block => block.dataset.meoExportMermaidError),
          actual: geometry(svg), explicitDagre: geometry(blocks[1]!.querySelector('svg')!), references,
          nodeFill: getComputedStyle(svg.querySelector('g.node .label-container')!).fill,
          customFill: custom && getComputedStyle(custom).fill,
          pieFills: Array.from(blocks[6]!.querySelectorAll('path.pieCircle')).map(slice => getComputedStyle(slice).fill),
          pieText: Array.from(blocks[6]!.querySelectorAll('text.slice')).map(label => getComputedStyle(label).fill),
          noteFill: getComputedStyle(blocks[3]!.querySelector('rect.note')!).fill,
          noteText: getComputedStyle(blocks[3]!.querySelector('.noteText')!).fill,
          sequenceLine: getComputedStyle(blocks[3]!.querySelector('.messageLine0')!).stroke,
          sequenceNumber: getComputedStyle(blocks[3]!.querySelector('.sequenceNumber')!).fill,
          ganttTasks: Array.from(blocks[8]!.querySelectorAll<SVGElement>('rect.task')).map(bar => {
            const label = blocks[8]!.querySelector<SVGElement>(`[id="${bar.id}-text"]`)!;
            return { background: getComputedStyle(bar).fill, foreground: getComputedStyle(label).fill,
              outside: /taskTextOutside/.test(label.getAttribute('class') ?? '') };
          }),
          customTask: getComputedStyle(blocks[9]!.querySelector('.done0')!).fill,
          customTaskText: getComputedStyle(blocks[9]!.querySelector('.doneText0')!).fill,
          look: config.look
        };
      }, flow);
      assert.ok(result.rendered.every(Boolean), `${target}/${appearance}: every diagram type must render: ${JSON.stringify(result.errors)}`);
      assert.equal(result.look, 'classic');
      assertReadableMermaidTasks(result.ganttTasks, `${target}/${appearance} Gantt`);
      assert.equal(result.customTask, 'rgb(255, 218, 185)', 'Author Gantt bar colors remain effective');
      assert.equal(result.customTaskText, 'rgb(36, 18, 8)', 'Author Gantt label colors remain effective');
      assert.ok(result.actual.edges.length > 0, 'Layout comparison must examine real rendered edges');
      assert.deepEqual(result.actual, result.references[0], 'Default output must really use ELK');
      assert.notDeepEqual(result.references[0], result.references[1], 'ELK must differ from Dagre on this fixture');
      assert.deepEqual(result.explicitDagre, result.references[1], 'Author layout overrides must remain effective');
      // HTML/PDF preserve the reading appearance; Word keeps its fixed light format.
      const palette = getMermaidPalette(target !== 'docx' && appearance === 'dark');
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
      assert.deepEqual(result.ganttTasks.slice(0, 3).map(task => task.background),
        [palette.doneTaskBackground, palette.activeTaskBackground, palette.taskBackground].map(rgb),
        'Every export target uses the shared low-saturation Gantt state colors');
      assert.equal(result.nodeFill, rgb(palette.nodeBackground), 'Export must use the shared diagram palette');
      assert.equal(result.customFill, 'rgb(255, 218, 185)', 'Author classDef colors must remain effective');
      assert.equal(result.noteFill, rgb(palette.secondaryBackground), 'Sequence notes must use a neutral surface');
      assert.equal(result.noteText, rgb(palette.foreground), 'Sequence notes must follow the reading foreground');
      assert.equal(result.sequenceLine, rgb(palette.line), 'Sequence messages must use the blue accent');
      assert.equal(result.sequenceNumber, target !== 'docx' && appearance === 'dark' ? rgb(palette.chartTextColor) : 'rgb(255, 255, 255)', 'Sequence numbers must contrast with the blue markers');
      assert.deepEqual(result.pieFills, palette.chartColors.slice(0, 8).map(rgb), 'Eight categories must use eight official accent colors');
      assert.ok(result.pieText.length === 8 && result.pieText.every(color => color === rgb(palette.chartTextColor)), 'Percentage labels must remain dark on pastel slices');
      console.log(`${target}/${appearance}: ${diagrams.length} types/configurations, real ELK, author overrides and palette passed`);
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequests, [], 'All layout engines must work from the shipped single file');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
