import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../app.js';
import { createBugReviewRouter } from './routes.js';
import { createBugReviewClient } from './sidecar-client.js';

test('HTTP bridge preserves business errors, snapshots and query encoding', async (t) => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/import')) { res.writeHead(422); res.end(JSON.stringify({code:'PR_NOT_MERGED',error:'尚未合入'})); }
    else res.end(JSON.stringify({reviews:[{id:'x',document:{completeness:'incomplete',gaps:['缺少根因']}}]}));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => stub.once('listening', resolve));
  const server = createApp({ bugReviewRouter: createBugReviewRouter({ client: createBugReviewClient({ baseUrl: `http://127.0.0.1:${stub.address().port}` }) }) }).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => {stub.closeAllConnections();stub.close();server.closeAllConnections();server.close();});
  const base = `http://127.0.0.1:${server.address().port}/api/bug-review`;
  const response = await fetch(base+'/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://github.com/a/b/pull/1'})});
  assert.equal(response.status,422);
  assert.equal((await response.json()).code,'PR_NOT_MERGED');
  const found = await (await fetch(base+'/library?q='+encodeURIComponent('错误 & upload'))).json();
  assert.equal(found.reviews[0].document.completeness,'incomplete');
  assert.equal(new URL(seen.at(-1),'http://localhost').searchParams.get('q'),'错误 & upload');
});

test('sidecar unavailable and timeout are actionable without leaking transport details', async () => {
  const client = createBugReviewClient({baseUrl:'http://127.0.0.1:1',timeoutMs:20});
  await assert.rejects(client.request('GET','/health'), e => e.code === 'BUG_REVIEW_UNAVAILABLE' && e.status === 503);
});
