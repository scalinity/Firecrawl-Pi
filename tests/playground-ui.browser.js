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
  return results;
}
