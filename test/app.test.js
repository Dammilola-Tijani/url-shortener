import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

function start(options) {
  const db = openDb(':memory:');
  const server = createApp(db, options).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => server.close(r));
  return { db, base, close };
}

const post = (base, body) =>
  fetch(`${base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let ctx;
before(() => { ctx = start(); });
after(() => ctx.close());

test('creates a link and redirects with a 302', async () => {
  const res = await post(ctx.base, { url: 'https://example.com/a?b=1' });
  assert.equal(res.status, 201);
  const { code, shortUrl } = await res.json();
  assert.match(code, /^[0-9a-zA-Z]{7}$/);
  assert.ok(shortUrl.endsWith(`/${code}`));

  const redirect = await fetch(`${ctx.base}/${code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/a?b=1');
});

test('rejects non-http(s) and malformed URLs', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not a url', '', 42, undefined]) {
    const res = await post(ctx.base, { url });
    assert.equal(res.status, 400, `expected 400 for ${String(url)}`);
  }
});

test('rejects malformed JSON with 400', async () => {
  const res = await fetch(`${ctx.base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
});

test('custom codes: accepted once, then 409; reserved/invalid rejected', async () => {
  assert.equal((await post(ctx.base, { url: 'https://example.com', customCode: 'my-link' })).status, 201);
  assert.equal((await post(ctx.base, { url: 'https://example.org', customCode: 'my-link' })).status, 409);
  assert.equal((await post(ctx.base, { url: 'https://example.com', customCode: 'api' })).status, 400);
  assert.equal((await post(ctx.base, { url: 'https://example.com', customCode: 'a b' })).status, 400);
});

test('unknown code returns 404', async () => {
  assert.equal((await fetch(`${ctx.base}/nope123`, { redirect: 'manual' })).status, 404);
});

test('records clicks and reports stats', async () => {
  const { code } = await (await post(ctx.base, { url: 'https://example.com/stats' })).json();
  await fetch(`${ctx.base}/${code}`, { redirect: 'manual', headers: { referer: 'https://news.example/post' } });
  await fetch(`${ctx.base}/${code}`, { redirect: 'manual', headers: { referer: 'https://news.example/post' } });
  await fetch(`${ctx.base}/${code}`, { redirect: 'manual' });

  const stats = await (await fetch(`${ctx.base}/api/links/${code}/stats`)).json();
  assert.equal(stats.totalClicks, 3);
  assert.equal(stats.clicksPerDay.length, 1);
  assert.equal(stats.clicksPerDay[0].clicks, 3);
  assert.deepEqual(stats.topReferrers, [
    { referrer: 'https://news.example/post', clicks: 2 },
    { referrer: '(direct)', clicks: 1 },
  ]);
});

test('expired links return 410 and are not counted', async () => {
  const { code } = await (await post(ctx.base, { url: 'https://example.com/old' })).json();
  ctx.db.prepare("UPDATE links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = ?").run(code);
  assert.equal((await fetch(`${ctx.base}/${code}`, { redirect: 'manual' })).status, 410);
  const stats = await (await fetch(`${ctx.base}/api/links/${code}/stats`)).json();
  assert.equal(stats.totalClicks, 0);
});

test('rejects expiresAt in the past', async () => {
  assert.equal((await post(ctx.base, { url: 'https://example.com', expiresAt: '2000-01-01' })).status, 400);
});

test('delete removes the link and its clicks', async () => {
  const { code } = await (await post(ctx.base, { url: 'https://example.com/del' })).json();
  await fetch(`${ctx.base}/${code}`, { redirect: 'manual' });
  assert.equal((await fetch(`${ctx.base}/api/links/${code}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${ctx.base}/${code}`, { redirect: 'manual' })).status, 404);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE code = ?').get(code).n, 0);
  assert.equal((await fetch(`${ctx.base}/api/links/${code}`, { method: 'DELETE' })).status, 404);
});

test('retries when a generated code collides with an existing one', async () => {
  const seq = ['aaaaaaa', 'aaaaaaa', 'bbbbbbb'];
  const c = start({ generateCode: () => seq.shift() });
  try {
    const first = await (await post(c.base, { url: 'https://example.com/1' })).json();
    assert.equal(first.code, 'aaaaaaa');
    // Generator now yields 'aaaaaaa' again (collision) and then 'bbbbbbb'.
    const second = await (await post(c.base, { url: 'https://example.com/2' })).json();
    assert.equal(second.code, 'bbbbbbb');
  } finally {
    await c.close();
  }
});

test('gives up with 503 if every attempt collides', async () => {
  const c = start({ generateCode: () => 'zzzzzzz' });
  try {
    assert.equal((await post(c.base, { url: 'https://example.com/1' })).status, 201);
    assert.equal((await post(c.base, { url: 'https://example.com/2' })).status, 503);
  } finally {
    await c.close();
  }
});

test('rate limits link creation per client', async () => {
  const c = start({ createLimit: { max: 3, windowMs: 60_000 } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(c.base, { url: `https://example.com/${i}` })).status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  } finally {
    await c.close();
  }
});

test('behind a trusted proxy, rate limiting is per real client, not per proxy', async () => {
  const c = start({ trustProxy: 1, createLimit: { max: 1, windowMs: 60_000 } });
  const asClient = (ip) =>
    fetch(`${c.base}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
  try {
    assert.equal((await asClient('203.0.113.1')).status, 201);
    assert.equal((await asClient('203.0.113.1')).status, 429); // same client: limited
    assert.equal((await asClient('203.0.113.2')).status, 201); // different client: allowed
  } finally {
    await c.close();
  }
});

test('root serves the landing page', async () => {
  const res = await fetch(`${ctx.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /URL Shortener/);
});
