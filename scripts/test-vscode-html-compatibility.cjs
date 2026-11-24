const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

exports.run = async () => {
  const output = process.env.MEO_HTML_COMPAT_OUTPUT;
  const fixture = JSON.parse(fs.readFileSync(path.join(output,'fixture.json'),'utf8'));
  const result = {version:vscode.version,passed:false,cases:[]};
  let browser;
  try {
    browser = await puppeteer.connect({browserURL:process.env.MEO_HTML_COMPAT_BROWSER_URL,defaultViewport:null});
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(output,'workspace','audit.md')));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markdown.showPreview',doc.uri);
    await vscode.commands.executeCommand('vscode.openWith',doc.uri,'vscode.markdown.preview.editor');
    let frame;
    const admissionStarted=Date.now();
    const deadline = admissionStarted+120_000;
    while (!frame && Date.now()<deadline) {
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        if (!candidate.url().startsWith('vscode-webview:')) continue;
        try { if (await candidate.evaluate(() => !!document.querySelector('.markdown-body'))) {frame=candidate;break;} }
        catch (error) { result.probeError=String(error); }
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve,100));
    }
    if (!frame) {
      result.frames=[];
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        try { result.frames.push({url:candidate.url(),state:await candidate.evaluate(() => ({title:document.title,body:document.body?.textContent?.slice(0,200),preview:!!document.querySelector('.markdown-body')}))}); } catch {}
      }
    }
    assert.ok(frame,'Built-in Markdown Preview must mount');
    result.coldAdmissionMs=Date.now()-admissionStarted;
    if (!await frame.evaluate(() => !!document.getElementById('audit-linked'))) {
      result.markup=await frame.evaluate(() => document.documentElement.outerHTML.slice(0,4500));
      throw new Error('Built-in Preview did not retain the HTML fixture identifiers');
    }
    await frame.waitForFunction(() => getComputedStyle(document.getElementById('audit-linked')).color==='rgb(12, 34, 56)'
      && getComputedStyle(document.getElementById('audit-imported')).color==='rgb(21, 43, 65)');
    const measure = async cases => {
      await document.fonts.ready;
      return {fontLoaded:[...document.fonts].some(face => /AuditFont|meo-html-font-/.test(face.family) && face.status==='loaded'),
        cases:Object.fromEntries(cases.map(item => {
          const node=document.getElementById('audit-'+item.id);
          return [item.id,node ? {tag:node.tagName,value:item.prop ? getComputedStyle(node,item.pseudo||null)[item.prop] : undefined,
            attr:item.attr ? node.getAttribute(item.attr) : undefined,text:item.text ? node.innerHTML : undefined} : null];
        }))};
    };
    const builtin = await frame.evaluate(measure,fixture.cases);
    assert.equal(builtin.fontLoaded,true,'Built-in stylesheet font must actually load');
    await frame.evaluate(html => {
      const root=document.createElement('div');root.className='meo-export-doc';root.innerHTML=html;
      document.querySelector('.markdown-body').replaceChildren(root);
    },fixture.html);
    const meo = await frame.evaluate(measure,fixture.cases);
    assert.equal(meo.fontLoaded,true,'MEO stylesheet font must actually load');
    for (const item of fixture.cases) {
      const reference=builtin.cases[item.id],actual=meo.cases[item.id];
      assert.ok(actual,item.id+' must render');
      if (item.id==='plaintext') {
        assert.equal(actual.text,'**literal?**','The documented literal HTML code rule remains explicit');
        result.cases.push({id:item.id,documentedDifference:true});
        continue;
      }
      if (item.id==='fontface') {
        assert.match(actual.value,/meo-html-font-/);
        result.cases.push({id:item.id,isolatedFont:true});
        continue;
      }
      if (item.id==='background') {
        assert.match(actual.value,/url\("data:image\/png;base64,/);
        assert.match(reference.value,/pixel.png/);
        result.cases.push({id:item.id,embeddedAsset:true});
        continue;
      }
      assert.deepEqual(actual,reference,item.id+' must match the built-in preview');
      result.cases.push({id:item.id,matched:true});
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith',doc.uri,'meoEnhanced.editor',{preview:false});
    let editorFrame;
    const editorDeadline=Date.now()+120_000;
    while (!editorFrame && Date.now()<editorDeadline) {
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        if (!candidate.url().startsWith('vscode-webview:')) continue;
        try { if (await candidate.evaluate(() => !!document.querySelector('#app[data-mode] .mode-group'))) {editorFrame=candidate;break;} } catch {}
      }
      if (!editorFrame) await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(editorFrame,'Production MEO must mount');
    await editorFrame.waitForFunction(() => !document.querySelector('.meo-preload-toolbar')
      && document.querySelector('.editor-loading')?.hidden === true
      && document.querySelector('.editor-host')?.inert === false
      && document.querySelector('button[data-mode="preview"]')?.disabled === false);
    await editorFrame.click('button[data-mode="live"]');
    const link = '.meo-md-html-link[data-meo-link-href="#audit-link-target"]';
    const anchor = await editorFrame.waitForSelector(link, { visible: true });
    await editorFrame.evaluate(() => {
      window.__nativeFragmentReveals = [];
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.id === 'audit-link-target') window.__nativeFragmentReveals.push(this.id);
        return scrollIntoView.apply(this, args);
      };
    });
    const editorPage = editorFrame.page();
    const bounds = await anchor.boundingBox();
    assert.ok(bounds, 'The rendered link must have pointer bounds');
    const middle = bounds.y + bounds.height / 2;
    await editorPage.mouse.move(bounds.x + 1, middle);
    await editorPage.mouse.down();
    await editorPage.mouse.move(bounds.x + bounds.width - 1, middle, { steps: 8 });
    await editorPage.mouse.up();
    await editorFrame.waitForFunction(() => window.getSelection()?.toString() === 'HTML link label');
    assert.ok(await editorFrame.$(link), 'Dragging keeps the rendered link in Live');
    assert.deepEqual(await editorFrame.evaluate(() => window.__nativeFragmentReveals), [],
      'Dragging a rendered link leaves the fragment target alone');
    result.liveLinkDrag = true;
    await editorFrame.evaluate(() => window.getSelection()?.removeAllRanges());
    await editorFrame.click(link);
    assert.deepEqual(await editorFrame.evaluate(() => window.__nativeFragmentReveals), [],
      'Plain Live clicks must not invoke native Webview fragment navigation');
    await editorFrame.waitForFunction(() => document.querySelector('.cm-activeLine')?.textContent.includes('<a href="#audit-link-target"'));
    await editorFrame.click('.cm-content .cm-line:first-child');
    await editorFrame.waitForSelector(link, { visible: true });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await editorPage.keyboard.down(modifier);
    try { await editorFrame.click(link); } finally { await editorPage.keyboard.up(modifier); }
    await editorFrame.waitForFunction(() => document.querySelector('.cm-activeLine')?.textContent.includes('Native fragment target.'));
    assert.deepEqual(await editorFrame.evaluate(() => window.__nativeFragmentReveals), [],
      'Live modifier clicks must reveal the target through MEO alone');
    result.liveLinkGestures = true;
    await editorFrame.click('button[data-mode="preview"]');
    await editorFrame.waitForFunction(() => {
      const doc=document.querySelector('.preview-frame')?.contentDocument;
      const node=doc?.getElementById('audit-linked');
      return node && doc.defaultView.getComputedStyle(node).color==='rgb(12, 34, 56)'
        && [...doc.fonts].some(face => face.family.includes('meo-html-font-') && face.status==='loaded');
    });
    const resourceState=await editorFrame.evaluate(() => {
      const doc=document.querySelector('.preview-frame').contentDocument;
      const style=id=>doc.defaultView.getComputedStyle(doc.getElementById(id));
      return {linked:style('audit-linked').color,imported:style('audit-imported').color,
        background:style('audit-background').backgroundImage,important:style('audit-important').color};
    });
    assert.equal(resourceState.imported,'rgb(21, 43, 65)');
    assert.equal(resourceState.important,'rgb(23, 45, 67)');
    assert.match(resourceState.background,/data:image\/png/);
    const cssDocument=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(output,'workspace','效果演示.css')));
    const edit=new vscode.WorkspaceEdit();
    edit.replace(cssDocument.uri,new vscode.Range(cssDocument.positionAt(0),cssDocument.positionAt(cssDocument.getText().length)),
      '#audit-linked{color:rgb(70,80,90)}');
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    assert.equal(await cssDocument.save(),true);
    await editorFrame.waitForFunction(() => {
      const doc=document.querySelector('.preview-frame')?.contentDocument;
      const node=doc?.getElementById('audit-linked');
      return node && doc.defaultView.getComputedStyle(node).color==='rgb(70, 80, 90)';
    });
    result.production={...resourceState,savedStylesheetRefresh:true};
    result.passed=true;
  } catch (error) {result.error=error.stack||String(error);throw error;}
  finally {
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    browser?.disconnect();
  }
};
