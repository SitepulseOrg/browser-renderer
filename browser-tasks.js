const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

export async function renderPage(page, url, { waitUntil, timeout, userAgent, contentTimeoutMs = 5_000 }) {
  let content;

  try {
    if (userAgent) await page.setUserAgent(userAgent);

    await page.setRequestInterception(true);
    page.on('request', request => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          return request.abort();
        }
        request.continue();
      } catch { /* Puppeteer may emit late requests during page shutdown. */ }
    });

    await page.goto(url, { waitUntil, timeout });
    content = page.content();

    return await withTimeout(content, contentTimeoutMs, 'page content timed out');
  } finally {
    try { await page.close(); } catch { /* Preserve the render result. */ }
    await content?.catch(() => {});
  }
}

export async function runLighthouse(url, { launchBrowser, timeoutMs, settings = {}, lighthouseRunner }) {
  let activeBrowser;
  let browserLaunch;
  let expired = false;

  const work = (async () => {
    const { default: desktopConfig } = await import('lighthouse/core/config/desktop-config.js');
    const lighthouse = lighthouseRunner ?? (await import('lighthouse')).default;
    if (expired) return;

    browserLaunch = launchBrowser();
    activeBrowser = await browserLaunch;
    if (expired) return;

    const port = Number.parseInt(new URL(activeBrowser.wsEndpoint()).port, 10);
    if (Number.isNaN(port)) throw new Error('browser debug port unavailable');

    return lighthouse(url, {
      logLevel: 'error',
      maxWaitForLoad: timeoutMs,
      onlyCategories: ['performance'],
      output: 'json',
      port,
      ...settings,
      disableFullPageScreenshot: true,
    }, desktopConfig);
  })();

  try {
    const result = await withTimeout(work, timeoutMs, 'lighthouse timed out');
    if (!result?.lhr) throw new Error('lighthouse did not return a result');

    return result.lhr;
  } finally {
    expired = true;
    // A browser that finishes launching after the deadline still needs closing.
    await browserLaunch?.catch(() => {});
    if (activeBrowser) {
      try {
        await activeBrowser.close();
      } catch {
        activeBrowser.process()?.kill('SIGKILL');
      }
    }
    await work.catch(() => {});
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = 'ETIMEDOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
