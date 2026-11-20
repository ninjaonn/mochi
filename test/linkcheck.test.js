const test = require('node:test');
const assert = require('node:assert');
const { classify, toRequestUrl, createChecker } = require('../src/linkcheck');

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over = {}) {
  const calls = [];
  const results = [];
  let time = 0;
  const checker = createChecker({
    probe: async (url) => { calls.push(url); return { status: 200 }; },
    isVpnOff: () => false,
    onResult: (r) => results.push(r),
    ttlMs: 1000,
    now: () => time,
    ...over,
  });
  return { checker, calls, results, advance: (ms) => { time += ms; } };
}

test('any answer below 500 means the site is alive', () => {
  for (const status of [200, 301, 401, 403, 404, 405]) assert.strictEqual(classify({ status }, false).state, 'up');
  assert.strictEqual(classify({ error: 'Redirect was cancelled' }, true).state, 'up');
});

test('server errors are down, even with the VPN off', () => {
  for (const status of [500, 502, 503, 504]) assert.strictEqual(classify({ status }, true).state, 'down');
});

test('a server that refuses HEAD is still up', () => {
  assert.strictEqual(classify({ status: 501 }, false).state, 'up');
});

test('no answer is only down when the VPN is not the likely reason', () => {
  const error = 'net::ERR_CONNECTION_TIMED_OUT';
  assert.strictEqual(classify({ error }, false).state, 'down');
  assert.strictEqual(classify({ error }, true).state, 'unknown');
});

test('an untrusted certificate still means the server answered', () => {
  const r = classify({ error: 'net::ERR_CERT_AUTHORITY_INVALID' }, true);
  assert.strictEqual(r.state, 'up');
  assert.match(r.detail, /certificate/);
});

test('only web links are requested', () => {
  assert.strictEqual(toRequestUrl('www.example.invalid'), 'https://www.example.invalid/');
  assert.strictEqual(toRequestUrl('https://example.invalid/a'), 'https://example.invalid/a');
  for (const bad of ['file:///C:/x', 'ftp://example.invalid', 'javascript:alert(1)', 'not a link']) {
    assert.strictEqual(toRequestUrl(bad), null);
  }
});

test('unsafe links never reach the network', async () => {
  const { checker, calls } = setup();
  checker.check(['file:///C:/secret.txt', 'ftp://example.invalid']);
  await tick();
  assert.deepStrictEqual(calls, []);
});

test('the same link is requested once, then cached until it expires', async () => {
  const { checker, calls, results, advance } = setup();
  const url = 'https://a.invalid/';
  assert.deepStrictEqual(checker.check([url, url]), {});
  await tick();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(results[0].state, 'up');

  assert.strictEqual(checker.check([url])[url].state, 'up');
  await tick();
  assert.strictEqual(calls.length, 1);

  advance(1001);
  checker.check([url]);
  await tick();
  assert.strictEqual(calls.length, 2);
});

test('force skips the cache', async () => {
  const { checker, calls } = setup();
  checker.check(['https://a.invalid/']);
  await tick();
  checker.check(['https://a.invalid/'], true);
  await tick();
  assert.strictEqual(calls.length, 2);
});

test('a link being checked is not requested twice', async () => {
  const { checker, calls } = setup();
  checker.check(['https://a.invalid/']);
  checker.check(['https://a.invalid/'], true);
  await tick();
  assert.strictEqual(calls.length, 1);
});

test('no more than the limit run at once', async () => {
  let active = 0;
  let peak = 0;
  const { checker, results } = setup({
    concurrency: 2,
    probe: async () => { active += 1; peak = Math.max(peak, active); await tick(); active -= 1; return { status: 200 }; },
  });
  checker.check(['1', '2', '3', '4', '5'].map((n) => `https://${n}.invalid/`));
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(results.length, 5);
  assert.strictEqual(peak, 2);
});

test('forget drops old results, including ones still running', async () => {
  let release;
  const { checker, results } = setup({ probe: () => new Promise((r) => { release = () => r({ error: 'net::ERR_TIMED_OUT' }); }) });
  checker.check(['https://a.invalid/']);
  checker.forget();
  release();
  await tick();
  assert.deepStrictEqual(results, []);
  assert.deepStrictEqual(checker.check([]), {});
});
