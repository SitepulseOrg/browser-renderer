import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { handleEvent } from '../lambda/handler.js';
import { runLighthouse } from '../browser-tasks.js';

const token = 'test-token';

function event({ method = 'POST', path = '/content', body = {}, headers = {} } = {}) {
  return {
    rawPath: path,
    requestContext: {
      http: {
        method,
      },
    },
    headers,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function authHeaders(value = token) {
  return {
    authorization: `Bearer ${value}`,
  };
}

test('rejects requests without the bearer token', async () => {
  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('rejects lighthouse requests without the bearer token', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
  }), {
    token,
    lighthouseRunner: async () => ({ categories: {} }),
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('rejects requests when the renderer token is not configured', async () => {
  const previousToken = process.env.RENDER_TOKEN;
  delete process.env.RENDER_TOKEN;

  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    renderUrl: async () => '<html></html>',
  });

  if (previousToken === undefined) {
    delete process.env.RENDER_TOKEN;
  } else {
    process.env.RENDER_TOKEN = previousToken;
  }

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'renderer token not configured' });
});

test('rejects missing urls', async () => {
  const response = await handleEvent(event({
    body: {},
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'url required' });
});

test('rejects unsupported url protocols', async () => {
  const response = await handleEvent(event({
    body: { url: 'file:///etc/passwd' },
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'unsupported url protocol' });
});

test('rejects missing lighthouse urls', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: {},
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => ({ categories: {} }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'url required' });
});

test('returns lighthouse results', async () => {
  const lighthouseResult = {
    categories: {
      performance: {
        score: 0.91,
      },
    },
  };
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.equal(options.timeoutMs, 120_000);
      assert.deepEqual(options.settings, {
        disableStorageReset: true,
        emulatedUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        formFactor: 'desktop',
        screenEmulation: {
          deviceScaleFactor: 1,
          disabled: false,
          height: 940,
          mobile: false,
          width: 1350,
        },
        throttling: {
          cpuSlowdownMultiplier: 1,
          downloadThroughputKbps: 0,
          requestLatencyMs: 0,
          rttMs: 0,
          throughputKbps: 0,
          uploadThroughputKbps: 0,
        },
        throttlingMethod: 'provided',
      });

      return lighthouseResult;
    },
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.lighthouseResult, lighthouseResult);
  assert.equal(body.source, 'browser-renderer');
  assert.equal(typeof body.durationMs, 'number');
});

test('strips lighthouse screenshot blobs from the response', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => ({
      audits: {
        'final-screenshot': { details: { data: 'data:image/webp;base64,huge' } },
        'screenshot-thumbnails': { details: { items: [{ data: 'data:image/webp;base64,huge' }] } },
      },
      categories: {
        performance: {
          score: 0.91,
        },
      },
      fullPageScreenshot: {
        screenshot: {
          data: 'data:image/webp;base64,huge',
        },
      },
    }),
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.lighthouseResult.fullPageScreenshot, undefined);
  assert.equal(body.lighthouseResult.audits['final-screenshot'], undefined);
  assert.equal(body.lighthouseResult.audits['screenshot-thumbnails'], undefined);
  assert.equal(body.lighthouseResult.categories.performance.score, 0.91);
});

test('keeps Lighthouse busy until timeout cleanup finishes, then accepts another audit', { timeout: 1_000 }, async () => {
  const work = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const finishClosing = Promise.withResolvers();
  const request = event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  });
  const pendingResponse = handleEvent(request, {
    token,
    lighthouseTimeoutMs: 1,
    lighthouseRunner: (url, options) => runLighthouse(url, {
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
    }),
  });

  await closing.promise;
  let nextRuns = 0;
  const nextOptions = {
    token,
    lighthouseRunner: async () => { nextRuns++; return { categories: {} }; },
  };
  const busyResponse = await handleEvent(request, nextOptions);
  assert.equal(busyResponse.statusCode, 503);
  assert.equal(nextRuns, 0);

  finishClosing.resolve();
  const response = await pendingResponse;
  assert.equal(response.statusCode, 504);
  assert.deepEqual(JSON.parse(response.body), { error: 'lighthouse timed out' });

  const nextResponse = await handleEvent(request, nextOptions);
  assert.equal(nextResponse.statusCode, 200);
  assert.equal(nextRuns, 1);
});

test('returns safe json when lighthouse fails', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => {
      throw new Error('lighthouse exploded');
    },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'lighthouse exploded' });
});

test('returns rendered content', async () => {
  const response = await handleEvent(event({
    body: {
      url: 'https://example.com',
      waitUntil: 'networkidle0',
      timeout: 12_000,
      userAgent: 'SitePulse',
    },
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.deepEqual(options, {
        waitUntil: 'networkidle0',
        timeout: 12_000,
        userAgent: 'SitePulse',
      });

      return '<html><body>rendered</body></html>';
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    content: '<html><body>rendered</body></html>',
  });
});

test('returns a non-2xx response for oversized rendered content', async () => {
  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    maxResponseBytes: 30,
    renderUrl: async () => '<html><body>too large</body></html>',
  });

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).error, 'rendered content too large');
});

test('responds to health checks', async () => {
  const response = await handleEvent(event({
    method: 'GET',
    path: '/healthz',
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
});

test('serves content without loading Lighthouse', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'lighthouse') throw new Error('Lighthouse loaded on the content path');
      return nextResolve(specifier, context);
    } });
    const { handleEvent } = await import('./lambda/handler.js');
    const response = await handleEvent(${JSON.stringify(event({
      body: { url: 'https://example.com' },
      headers: authHeaders(),
    }))}, {
      token: ${JSON.stringify(token)},
      renderUrl: async () => '<html>rendered</html>',
    });
    assert.equal(response.statusCode, 200);
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5_000 });

  assert.equal(result.status, 0, result.stderr);
});
