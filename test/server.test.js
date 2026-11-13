import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { createApp } from '../server.js';
import { runLighthouse } from '../browser-tasks.js';

const token = 'test-token';

async function fixture(t, options = {}) {
  const app = createApp({ token, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    app,
    origin,
    async request({ method = 'POST', path = '/content', body = {}, headers = { authorization: `Bearer ${token}` } } = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

for (const path of ['/content', '/lighthouse']) {
  test(`rejects ${path} requests with missing or incorrect bearer tokens`, async t => {
    const { request } = await fixture(t);
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
      const response = await request({ path, body: { url: 'https://example.com' }, headers });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'unauthorized' });
    }
  });
}

test('rejects requests when the renderer token is not configured', async t => {
  const { request } = await fixture(t, { token: '' });
  const response = await request({ body: { url: 'https://example.com' } });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'renderer token not configured' });
});

for (const path of ['/content', '/lighthouse']) {
  test(`rejects missing and invalid ${path} URLs`, async t => {
    const { request } = await fixture(t);
    for (const [body, error] of [
      [{}, 'url required'],
      [{ url: 'not a URL' }, 'invalid url'],
      [{ url: 'file:///etc/passwd' }, 'unsupported url protocol'],
    ]) {
      const response = await request({ path, body });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error });
    }
  });
}

test('returns Lighthouse results using the shared desktop benchmark', async t => {
  const lighthouseResult = { categories: { performance: { score: 0.91 } } };
  const { request } = await fixture(t, {
    lighthouseRunner: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.equal(options.timeoutMs, 120_000);
      assert.equal(options.settings, undefined);
      return lighthouseResult;
    },
  });
  const response = await request({ path: '/lighthouse', body: { url: 'https://example.com' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.lighthouseResult, lighthouseResult);
  assert.equal(response.body.source, 'browser-renderer');
  assert.equal(typeof response.body.durationMs, 'number');
});

test('strips Lighthouse screenshot blobs and preserves diagnostics', async t => {
  const { request } = await fixture(t, {
    lighthouseRunner: async () => ({
      audits: {
        'long-tasks': { details: { items: [{ duration: 350 }] } },
        'final-screenshot': { details: { data: 'data:image/webp;base64,huge' } },
        'screenshot-thumbnails': { details: { items: [{ data: 'data:image/webp;base64,huge' }] } },
      },
      categories: { performance: { score: 0.91 } },
      fullPageScreenshot: { screenshot: { data: 'data:image/webp;base64,huge' } },
      environment: { benchmarkIndex: 1500 },
      runWarnings: ['The page loaded too slowly.'],
      configSettings: { formFactor: 'desktop', throttlingMethod: 'simulate' },
    }),
  });
  const response = await request({ path: '/lighthouse', body: { url: 'https://example.com' } });
  assert.equal(response.status, 200);
  const lhr = response.body.lighthouseResult;
  assert.equal(lhr.fullPageScreenshot, undefined);
  assert.equal(lhr.audits['final-screenshot'], undefined);
  assert.equal(lhr.audits['screenshot-thumbnails'], undefined);
  assert.equal(lhr.categories.performance.score, 0.91);
  assert.deepEqual(lhr.audits['long-tasks'].details.items, [{ duration: 350 }]);
  assert.equal(lhr.environment.benchmarkIndex, 1500);
  assert.deepEqual(lhr.runWarnings, ['The page loaded too slowly.']);
  assert.equal(lhr.configSettings.throttlingMethod, 'simulate');
});

test('keeps Lighthouse busy until timeout cleanup finishes, then accepts another audit', { timeout: 3_000 }, async t => {
  const work = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const finishClosing = Promise.withResolvers();
  let runs = 0;
  const { request } = await fixture(t, {
    lighthouseTimeoutMs: 1,
    lighthouseRunner: (url, options) => {
      if (runs++ > 0) return { categories: {} };
      return runLighthouse(url, {
        ...options,
        launchBrowser: async () => ({
          wsEndpoint: () => 'ws://127.0.0.1:9222/browser/test',
          close: async () => {
            closing.resolve();
            await finishClosing.promise;
            work.reject(new Error('browser closed'));
          },
        }),
        lighthouseRunner: () => work.promise,
      });
    },
  });
  const options = { path: '/lighthouse', body: { url: 'https://example.com' } };
  const pendingResponse = request(options);
  await closing.promise;
  const busyResponse = await request(options);
  assert.equal(busyResponse.status, 503);
  assert.equal(runs, 1);
  finishClosing.resolve();
  const response = await pendingResponse;
  assert.equal(response.status, 504);
  assert.deepEqual(response.body, { error: 'lighthouse timed out' });
  assert.equal((await request(options)).status, 200);
  assert.equal(runs, 2);
});

test('returns JSON when Lighthouse fails and permits the next audit', async t => {
  let runs = 0;
  const { request } = await fixture(t, {
    lighthouseRunner: async () => {
      if (runs++ === 0) throw new Error('lighthouse exploded');
      return { categories: {} };
    },
  });
  const options = { path: '/lighthouse', body: { url: 'https://example.com' } };
  const response = await request(options);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'lighthouse exploded' });
  assert.equal((await request(options)).status, 200);
});

test('returns rendered content with the requested settings', async t => {
  const { request } = await fixture(t, {
    renderUrl: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.deepEqual(options, { waitUntil: 'networkidle0', timeout: 12_000, userAgent: 'SitePulse' });
      return '<html><body>rendered</body></html>';
    },
  });
  const response = await request({ body: {
    url: 'https://example.com', waitUntil: 'networkidle0', timeout: 12_000, userAgent: 'SitePulse',
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { content: '<html><body>rendered</body></html>' });
});

test('returns a non-2xx response for oversized rendered content', async t => {
  const { request } = await fixture(t, {
    maxResponseBytes: 30,
    renderUrl: async () => '<html><body>too large</body></html>',
  });
  const response = await request({ body: { url: 'https://example.com' } });
  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'rendered content too large');
});

test('responds to health checks before the first browser launch', async t => {
  const { request } = await fixture(t);
  const response = await request({ method: 'GET', path: '/healthz', headers: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.browserConnected, false);
});

test('rejects new work and reports unhealthy during shutdown', async t => {
  const { app, request } = await fixture(t);
  await app.locals.shutdown();
  assert.equal((await request({ method: 'GET', path: '/healthz' })).status, 503);
  const response = await request({ body: { url: 'https://example.com' } });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'shutting down' });
});

test('serves content without loading Lighthouse', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('lighthouse')) throw new Error('Lighthouse loaded on the content path');
      return nextResolve(specifier, context);
    } });
    const { createApp } = await import('./server.js');
    const app = createApp({ token: 'test-token', renderUrl: async () => '<html>rendered</html>' });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/content', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(response.status, 200);
    await response.json();
    await new Promise(resolve => server.close(resolve));
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
});
