async (page) => {
  const results = [];
  for (const uncertain of [false, true]) {
    const tab = await page.context().newPage();
    const calls = [];
    try {
      await tab.route('**/api/status', route => route.fulfill({ json: { status: 200, data: { core: { live: true }, ledger: { ok: true } } } }));
      await tab.route('**/api/run', async route => {
        calls.push(route.request().postDataJSON());
        if (calls.length === 1) {
          if (uncertain) return route.abort('failed');
          return route.fulfill({ status: 400, json: { error: 'Each URL must use http or https.' } });
        }
        return route.fulfill({ json: { status: 200, data: { success: true, id: '00000000-0000-4000-8000-000000000001' } } });
      });
      await tab.goto('http://localhost:8767/LLM-DEMO.html');
      await tab.locator('[data-tool="crawl"]').first().click();
      await tab.locator('#target').fill(uncertain ? 'https://example.com/original' : 'ftp://example.com');
      await tab.locator('#run').click();
      await tab.waitForFunction(() => !document.querySelector('#run').disabled);
      await tab.locator('#target').fill('https://example.com/corrected');
      await tab.locator('#run').click();
      if (uncertain) {
        await tab.getByText('A previous crawl has an uncertain response.', { exact: false }).waitFor();
        if (calls.length !== 1) throw Error('An uncertain submission was replaced');
      } else {
        await tab.waitForFunction(() => document.querySelector('#job-id').value === '00000000-0000-4000-8000-000000000001');
        if (calls.length !== 2 || calls[1].input !== 'https://example.com/corrected') throw Error('Corrected crawl was not submitted');
      }
      results.push({ check: uncertain ? 'uncertain crawl stays protected' : 'locally rejected crawl can be corrected', state: 'PASS' });
    } finally { await tab.close(); }
  }
  const native = await page.context().newPage();
  try {
    await native.route('**/api/status', route => route.fulfill({ json: { status: 200, data: { core: { live: true } } } }));
    await native.route('**/api/run', route => route.fulfill({json:{status:200,data:{success:true,data:{markdown:'Native export fixture',metadata:{sourceURL:'https://example.com/'}}}}}));
    await native.addInitScript(() => {
      window.nativeCalls = [];
      window.savedResults = [];
      window.saveOutcome = true;
      window.__TAURI__ = { core: { invoke: async (command,payload) => {
        window.savedResults.push({command,payload});
        if(window.saveOutcome==='error')throw Error('fixture failure');
        return window.saveOutcome;
      } }, window: { getCurrentWindow: () => Object.fromEntries(
        ['minimize','toggleMaximize','close','startDragging'].map(name => [name, () => { window.nativeCalls.push(name); return Promise.resolve(); }])
      ) } };
    });
    await native.goto('http://localhost:8767/LLM-DEMO.html');
    await native.locator('#window-controls').waitFor({state:'visible'});
    const controls = await native.evaluate(() => {
      const group = document.querySelector('#window-controls').getBoundingClientRect();
      const header = document.querySelector('.topbar').getBoundingClientRect();
      return {top:group.top-header.top,right:header.right-group.right,buttons:[...document.querySelectorAll('#window-controls button')].map(button=>{const r=button.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top};})};
    });
    if(controls.top!==12||controls.right!==12||controls.buttons.some(button=>button.width!==32||button.height!==32||button.top!==controls.buttons[0].top))throw Error('Desktop controls lack symmetric corner spacing: '+JSON.stringify(controls));
    for (const id of ['window-minimize','window-maximize','window-close']) await native.locator('#'+id).click();
    await native.locator('.topbar').dispatchEvent('mousedown',{button:0,detail:1});
    await native.locator('.topbar').dispatchEvent('mousedown',{button:0,detail:2});
    await native.locator('.topbar').dispatchEvent('mousedown',{button:2,detail:1});
    await native.locator('#connection').dispatchEvent('mousedown',{button:0,detail:1});
    const calls = await native.evaluate(() => window.nativeCalls);
    if (JSON.stringify(calls) !== JSON.stringify(['minimize','toggleMaximize','close','startDragging','toggleMaximize'])) throw Error('Native command or drag wiring differs: '+JSON.stringify(calls));
    results.push({check:'desktop controls and header drag wiring (mock native API)',state:'PASS'});
    await native.locator('#target').fill('https://example.com/');
    await native.locator('#run').click();
    await native.waitForFunction(() => !document.querySelector('#run').disabled);
    await native.locator('#save').click();
    await native.getByText('JSON result saved.',{exact:true}).waitFor();
    const saved = await native.evaluate(() => window.savedResults);
    if(saved.length!==1||saved[0].command!=='save_result'||JSON.parse(saved[0].payload.json).data.data.markdown!=='Native export fixture')throw Error('Native save received the wrong result');
    await native.evaluate(() => {window.saveOutcome=false;});
    await native.locator('#save').click();
    await native.getByText('Save cancelled.',{exact:true}).waitFor();
    await native.evaluate(() => {window.saveOutcome='error';});
    await native.locator('#save').click();
    await native.getByText('The JSON result could not be saved.',{exact:false}).waitFor();
    if(!await native.locator('#save').isEnabled())throw Error('Save did not recover after an error');
    results.push({check:'native JSON export, dialog cancellation and write failure (mock native API)',state:'PASS'});
  } finally { await native.close(); }
  const markdownTab = await page.context().newPage();
  const markdown = '# Release notes\n\n**Stable** and *readable*.\n\n| Platform | Installer |\n| --- | --- |\n| macOS | Universal |\n\n- First item\n- Second item\n\n> A quoted note\n\n```js\nconst text = "<unsafe>";\n```\n\n[Documentation](https://example.com/docs)\n\n[Unsafe](javascript:alert(1))\n<img src="https://example.com/tracker" onerror="window.markdownXss=1">\n<svg onload="window.markdownXss=1"></svg><script>window.markdownXss=1</script><style>body{display:none}</style><iframe src="https://example.com/frame"></iframe><form><input id="run" name="__TAURI__"></form>\n';
  try {
    await markdownTab.route('**/api/status',route=>route.fulfill({json:{status:200,data:{core:{live:true},ledger:{ok:true}}}}));
    await markdownTab.route('**/api/run',route=>route.fulfill({json:{status:200,data:{success:true,data:{markdown,metadata:{title:'Fixture release notes',sourceURL:'https://example.com/'}}}}}));
    await markdownTab.goto('http://localhost:8767/LLM-DEMO.html');
    await markdownTab.locator('#target').fill('https://example.com/');
    await markdownTab.locator('#run').click();
    await markdownTab.locator('#output .markdown-body h1').waitFor();
    if(await markdownTab.locator('[data-view="content"]').getAttribute('aria-selected')!=='true')throw Error('Content is not the default view');
    if(await markdownTab.locator('#output table tbody tr').count()!==1||await markdownTab.locator('#output strong').textContent()!=='Stable'||await markdownTab.locator('#output pre code').textContent()!=='const text = "<unsafe>";\n')throw Error('Markdown structure was not rendered');
    if(await markdownTab.locator('#output script,#output img,#output svg,#output style,#output iframe,#output form,#output input,#output [onerror],#output a[href^="javascript:"],#output unsafe').count())throw Error('Unsafe Markdown output survived');
    if(await markdownTab.evaluate(()=>window.markdownXss))throw Error('Untrusted content executed');
    if(await markdownTab.locator('#output a[href="https://example.com/docs"]').getAttribute('rel')!=='noopener noreferrer')throw Error('Source link lacks isolation');
    await markdownTab.locator('[data-view="markdown"]').click();
    if(await markdownTab.locator('#output article pre').textContent()!==markdown)throw Error('Raw Markdown changed');
    if(await markdownTab.locator('#output .markdown-body').count())throw Error('Markdown tab parsed the source');
    await markdownTab.locator('[data-view="content"]').click();
    await markdownTab.setViewportSize({width:390,height:844});
    const overflow=await markdownTab.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow)throw Error('Formatted content overflows the phone viewport');
    await markdownTab.screenshot({path:'.playwright-mcp/fcpi-markdown-390.png',fullPage:true});
    results.push({check:'formatted default Content, exact raw Markdown, XSS removal and 390px layout',state:'PASS'});
  } finally {await markdownTab.close();}
  const balanceTab = await page.context().newPage();
  let settled=0,reserved=0,available=true;
  try {
    await balanceTab.clock.install();
    await balanceTab.route('**/api/status',route=>route.fulfill({json:{status:200,data:{core:{live:true},ledger:{ok:true},providers:available?{
      caps:{llm:{unit:'micro_usd',caps:{month:20000000}}},
      budgets:[{category:'llm',period:'month',settled,reserved}]
    }:null}}}));
    await balanceTab.route('**/api/run',route=>{settled+=50000;return route.fulfill({json:{status:200,data:{success:true,data:{markdown:'Balance fixture'}}}});});
    await balanceTab.goto('http://localhost:8767/LLM-DEMO.html');
    await balanceTab.locator('#llm-balance').filter({hasText:'$20.00'}).waitFor();
    if(/approved|month/.test(await balanceTab.locator('.budget').textContent()))throw Error('Subscription wording remains');
    await balanceTab.locator('#target').fill('https://example.com/');
    await balanceTab.locator('#llm').check();
    await balanceTab.locator('#run').click();
    await balanceTab.locator('#llm-balance').filter({hasText:'$19.95'}).waitFor();
    reserved=100000;
    await balanceTab.clock.fastForward(30000);
    await balanceTab.locator('#llm-balance').filter({hasText:'$19.85'}).waitFor();
    if(!/\$0.10 in progress/.test(await balanceTab.locator('#llm-balance-note').textContent()))throw Error('Reserved spending is not explained');
    reserved=0;settled=75000;
    await balanceTab.locator('[data-tool="agent"]').first().click();
    await balanceTab.locator('#agent-task').fill('Read the fixture.');
    await balanceTab.route('**/api/agent',route=>{settled+=50000;return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'result',result:{status:200,data:{success:true,status:'completed',answer:'Fixture answer',findings:[],sources:[],documents:[],steps:[],usage:null}}})+'\n'});});
    await balanceTab.locator('#run').click();
    await balanceTab.locator('#llm-balance').filter({hasText:'$19.88'}).waitFor();
    available=false;
    await balanceTab.locator('#connection').click();
    await balanceTab.locator('#llm-balance').filter({hasText:'—'}).waitFor();
    if(!/unavailable/.test(await balanceTab.locator('#llm-balance-note').textContent()))throw Error('Missing usage looks like a known balance');
    available=true;settled=21000000;
    await balanceTab.locator('#connection').click();
    await balanceTab.locator('#llm-balance').filter({hasText:'$0.00'}).waitFor();
    results.push({check:'live LLM balance after extraction and Agent, periodic reservation refresh, unavailable state and exhausted cap',state:'PASS'});
  } finally {await balanceTab.close();}
  return results;
}
