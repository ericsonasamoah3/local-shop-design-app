// Polite HTTP client for ingestion.
//
// Everything this pipeline touches belongs to someone else, so requests are
// throttled per host, identify themselves, time out rather than hanging, and
// back off when a server says it is busy. Node 20 has global fetch, so there
// is no client dependency to add.

const USER_AGENT =
  process.env.INGEST_USER_AGENT ||
  'local-shop-design-app/0.1 (catalogue ingestion; +https://github.com/ericsonasamoah3/local-shop-design-app)';

// Minimum gap between two requests to the SAME host. Overpass and Nominatim
// both ask for roughly one request per second; shops get the same courtesy.
const MIN_HOST_INTERVAL_MS = Number(process.env.INGEST_HOST_INTERVAL_MS || 1200);
const REQUEST_TIMEOUT_MS = Number(process.env.INGEST_TIMEOUT_MS || 20000);
const MAX_RETRIES = 3;

// host -> timestamp we are next allowed to call it.
const nextAllowedAt = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHostSlot(host) {
  const now = Date.now();
  const earliest = nextAllowedAt.get(host) || 0;
  if (earliest > now) await sleep(earliest - now);
  nextAllowedAt.set(host, Math.max(now, earliest) + MIN_HOST_INTERVAL_MS);
}

/**
 * Fetch with politeness, timeout and backoff.
 * Returns the Response on 2xx, or null on 404/410 and on give-up, so callers
 * can treat "this shop does not expose that endpoint" as an ordinary outcome
 * rather than an exception.
 */
async function politeFetch(url, { accept = 'application/json', retries = MAX_RETRIES } = {}) {
  const { host } = new URL(url);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await waitForHostSlot(host);

    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout, DNS failure, connection reset. Worth one more try, but a
      // shop that cannot be reached twice is simply skipped.
      if (attempt === retries) return null;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (response.ok) return response;

    // Not there, or deliberately gone: a definite answer, not a failure.
    if (response.status === 404 || response.status === 410) return null;

    // Busy or broken. Honour Retry-After when the server sends one.
    if (response.status === 429 || response.status >= 500) {
      if (attempt === retries) return null;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt);
      continue;
    }

    // 401/403 and friends: we are not welcome here. Do not hammer.
    return null;
  }

  return null;
}

async function fetchJson(url) {
  const response = await politeFetch(url, { accept: 'application/json' });
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    // Plenty of shops answer /products.json with an HTML error page.
    return null;
  }
}

async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const response = await politeFetch(url, { accept });
  if (!response) return null;
  try {
    return await response.text();
  } catch {
    return null;
  }
}

module.exports = { politeFetch, fetchJson, fetchText, USER_AGENT, sleep };
