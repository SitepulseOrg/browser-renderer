import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeConfig } from 'lighthouse/core/config/config.js';

import { renderPage, runLighthouse } from '../browser-tasks.js';

function page(overrides = {}) {
  return {
    setUserAgent: async () => {},
    setRequestInterception: async () => {},
    on() {},
    goto: async () => {},
    content: async () => '<html>rendered</html>',
    close: async () => {},
    ...overrides,
  };
}

function browser(close) {
  return { wsEndpoint: () => 'ws://127.0.0.1:9222/browser/test', close };
}

test('renders HTML with the requested navigation settings and closes the page', async () => {
  let closed = false;
  let requestHandler;
  const content = await renderPage(page({
    setUserAgent: async value => assert.equal(value, 'Sitepulse'),
    setRequestInterception: async value => assert.equal(value, true),
    on: (event, handler) => {
      assert.equal(event, 'request');
      requestHandler = handler;
    },
    goto: async (url, options) => {
      assert.equal(url, 'https://example.com');
      assert.deepEqual(options, { waitUntil: 'networkidle2', timeout: 30_000 });
    },
    close: async () => { closed = true; },
  }), 'https://example.com', { waitUntil: 'networkidle2', timeout: 30_000, userAgent: 'Sitepulse' });

  assert.equal(content, '<html>rendered</html>');
  assert.equal(closed, true);
  const actions = [];
  for (const type of ['image', 'media', 'font', 'stylesheet', 'script', 'document', 'xhr']) {
    requestHandler({
      resourceType: () => type,
      abort: () => actions.push(`${type}:abort`),
      continue: () => actions.push(`${type}:continue`),
    });
  }
  assert.deepEqual(actions, [
    'image:abort', 'media:abort', 'font:abort', 'stylesheet:abort',
    'script:continue', 'document:continue', 'xhr:continue',
  ]);
});

test('HTML extraction times out and waits for page cleanup', { timeout: 1_000 }, async () => {
  const content = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const finishClosing = Promise.withResolvers();
  let settled = false;
  const result = renderPage(page({
    content: () => content.promise,
    close: async () => {
      closing.resolve();
      await finishClosing.promise;
      content.reject(new Error('target closed'));
    },
  }), 'https://example.com', { contentTimeoutMs: 1 });
  const rejected = assert.rejects(result, { code: 'ETIMEDOUT', message: 'page content timed out' });
  result.then(() => { settled = true; }, () => { settled = true; });

  await closing.promise;
  assert.equal(settled, false);
  finishClosing.resolve();
  await rejected;
  assert.equal(settled, true);
});

test('closes the page when navigation fails and preserves the error', async () => {
  let closed = false;
  const error = new Error('navigation failed');

  await assert.rejects(renderPage(page({
    goto: async () => { throw error; },
    close: async () => { closed = true; throw new Error('already closed'); },
  }), 'https://example.com', {}), error);
  assert.equal(closed, true);
});

test('closes the page when HTML extraction fails and preserves the error', async () => {
  let closed = false;
  const error = new Error('execution context destroyed');
  await assert.rejects(renderPage(page({
    content: async () => { throw error; },
    close: async () => { closed = true; },
  }), 'https://example.com', {}), error);
  assert.equal(closed, true);
});

test('runs a cold desktop Lighthouse benchmark without full-page screenshots and closes its browser', async () => {
  let closed = false;
  let resolvedSettings;
  const lhr = { categories: { performance: { score: 0.9 } } };
  const result = await runLighthouse('https://example.com', {
    launchBrowser: async () => browser(async () => { closed = true; }),
    timeoutMs: 1_000,
    lighthouseRunner: async (url, flags, config) => {
      assert.equal(url, 'https://example.com');
      assert.equal(flags.disableFullPageScreenshot, true);
      const { resolvedConfig } = await initializeConfig('navigation', config, flags);
      resolvedSettings = resolvedConfig.settings;
      assert.deepEqual(flags.onlyCategories, ['performance']);
      assert.equal(flags.port, 9222);
      return { lhr };
    },
  });

  assert.deepEqual(result, lhr);
  assert.equal(closed, true);
  assert.equal(resolvedSettings.formFactor, 'desktop');
  assert.equal(resolvedSettings.screenEmulation.mobile, false);
  assert.equal(resolvedSettings.throttlingMethod, 'simulate');
  assert.equal(resolvedSettings.throttling.rttMs, 40);
  assert.equal(resolvedSettings.throttling.throughputKbps, 10_240);
  assert.equal(resolvedSettings.throttling.cpuSlowdownMultiplier, 1);
  assert.equal(resolvedSettings.disableStorageReset, false);
});

test('Lighthouse timeout waits for browser closure and runner cleanup', { timeout: 1_000 }, async () => {
  const work = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const finishClosing = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  const finishCleaning = Promise.withResolvers();
  let settled = false;
  const result = runLighthouse('https://example.com', {
    timeoutMs: 1,
    launchBrowser: async () => browser(async () => {
      closing.resolve();
      await finishClosing.promise;
      work.reject(new Error('browser closed'));
    }),
    lighthouseRunner: async () => {
      try {
        return await work.promise;
      } finally {
        cleaning.resolve();
        await finishCleaning.promise;
      }
    },
  });
  const rejected = assert.rejects(result, { code: 'ETIMEDOUT', message: 'lighthouse timed out' });
  result.then(() => { settled = true; }, () => { settled = true; });

  await closing.promise;
  assert.equal(settled, false);
  finishClosing.resolve();
  await cleaning.promise;
  assert.equal(settled, false);
  finishCleaning.resolve();
  await rejected;
});

test('closes a browser launched after the Lighthouse deadline without starting an audit', { timeout: 1_000 }, async () => {
  const launch = Promise.withResolvers();
  let closed = false;
  let runs = 0;
  const result = runLighthouse('https://example.com', {
    timeoutMs: 1,
    launchBrowser: () => launch.promise,
    lighthouseRunner: async () => { runs++; return { lhr: {} }; },
  });
  const rejected = assert.rejects(result, { code: 'ETIMEDOUT' });

  await delay(10);
  launch.resolve(browser(async () => { closed = true; }));
  await rejected;
  assert.equal(closed, true);
  assert.equal(runs, 0);
});

test('closes the browser when Lighthouse fails and preserves the audit error', async () => {
  let closed = false;
  const error = new Error('audit failed');
  await assert.rejects(runLighthouse('https://example.com', {
    timeoutMs: 1_000,
    launchBrowser: async () => browser(async () => { closed = true; }),
    lighthouseRunner: async () => { throw error; },
  }), error);
  assert.equal(closed, true);
});

test('returns a browser launch error without starting Lighthouse', async () => {
  const error = new Error('launch failed');
  await assert.rejects(runLighthouse('https://example.com', {
    timeoutMs: 1_000,
    launchBrowser: async () => { throw error; },
    lighthouseRunner: async () => assert.fail('audit must not start'),
  }), error);
});

test('closes the browser when Lighthouse returns no result', async () => {
  let closed = false;
  await assert.rejects(runLighthouse('https://example.com', {
    timeoutMs: 1_000,
    launchBrowser: async () => browser(async () => { closed = true; }),
    lighthouseRunner: async () => undefined,
  }), { message: 'lighthouse did not return a result' });
  assert.equal(closed, true);
});

test('kills its browser if graceful closure fails after a timeout', { timeout: 1_000 }, async () => {
  const work = Promise.withResolvers();
  let killed = false;
  await assert.rejects(runLighthouse('https://example.com', {
    timeoutMs: 1,
    launchBrowser: async () => ({
      ...browser(async () => { throw new Error('close failed'); }),
      process: () => ({ kill: signal => {
        assert.equal(signal, 'SIGKILL');
        killed = true;
        work.reject(new Error('browser killed'));
      } }),
    }),
    lighthouseRunner: () => work.promise,
  }), { code: 'ETIMEDOUT' });
  assert.equal(killed, true);
});
