// Gathering shops around a user's location, on demand.
//
// The baked catalogue covers one place (wherever run.js was last pointed).
// When a user shares a location we have not looked at, this runs the same
// ingestion pipeline around them in the background — OpenStreetMap to find
// shops, then each shop's own Shopify/WooCommerce/JSON-LD catalogue — and
// saves the result to AREA_DIR, where catalogStore.js merges it in. The next
// visitor from the same area gets it instantly.
//
// It is still kept OUT of the request path: the API answers "gathering"
// immediately and the frontend polls, so a slow or hostile shop can only
// delay this job, never a user's request. One job runs at a time, and a daily
// cap bounds what the public endpoint can make us crawl.
//
// Cost: bandwidth, plus — only when ANTHROPIC_API_KEY is set — the Claude
// classification pass in normalize/classify.js for products the keyword
// rules could not place, typically a few cents an area.
//
// Job state is in memory, like compositeService.js: a restart forgets
// in-flight jobs, but finished areas are on disk and survive.

const fs = require('fs');
const path = require('path');

const { getCatalog, reload, AREA_DIR } = require('./catalogStore');
const { shopDistance, distanceMiles } = require('./geo');
const { discoverShopsAt } = require('../ingestion/discover/osm');
const { collectProducts } = require('../ingestion/collect');
const { buildCatalog } = require('../ingestion/normalize/product');

// A user is "covered" with this many shops within NEAR_MILES.
const NEAR_MILES = Number(process.env.AREA_NEAR_MILES || 15);
const MIN_NEARBY_SHOPS = Number(process.env.AREA_MIN_NEARBY_SHOPS || 3);

// How far to search when gathering, and how many shops to try. Kept smaller
// than run.js's defaults so a user waits minutes, not tens of minutes.
const SEARCH_RADIUS_M = Number(process.env.AREA_SEARCH_RADIUS_M || 20000);
const MAX_SHOPS = Number(process.env.AREA_MAX_SHOPS || 25);
const CONCURRENCY = Number(process.env.AREA_CONCURRENCY || 4);

// An earlier search this close to the user counts as having looked here,
// even if it found nothing, until it is this old.
const SEARCHED_WITHIN_MILES = (SEARCH_RADIUS_M / 1609.34) * 0.6;
const SEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_JOBS_PER_DAY = Number(process.env.AREA_MAX_JOBS_PER_DAY || 20);
const MAX_QUEUE = 3;

// Jobs are deduplicated by a ~10km grid cell, so many users in one town
// trigger one crawl.
function cellKey({ lat, lon }) {
  return `${lat.toFixed(1)}_${lon.toFixed(1)}`;
}

const jobs = new Map(); // cellKey -> { status: 'queued'|'running'|'failed', origin, error }
const queue = [];
let running = false;
let dayStartedAt = Date.now();
let jobsToday = 0;

function nearbyShopCount(origin) {
  return getCatalog().shops.filter((shop) => {
    const d = shopDistance(shop, origin);
    return d !== null && d <= NEAR_MILES;
  }).length;
}

function recentlySearched(origin) {
  const now = Date.now();
  return getCatalog().areas.some(
    (area) =>
      area.origin &&
      now - Date.parse(area.generated_at) < SEARCH_TTL_MS &&
      distanceMiles(origin, area.origin) <= SEARCHED_WITHIN_MILES
  );
}

/**
 * What we know about shops near this point, without starting anything.
 *   covered     — enough shops nearby to suggest from
 *   gathering   — a job for this area is queued or running
 *   none_found  — we searched here recently and found too few shops
 *   not_covered — nobody has looked here yet
 */
function getCoverage(origin) {
  const nearby = nearbyShopCount(origin);
  const job = jobs.get(cellKey(origin));

  if (job && (job.status === 'queued' || job.status === 'running')) {
    return { status: 'gathering', shops_nearby: nearby };
  }
  if (nearby >= MIN_NEARBY_SHOPS) return { status: 'covered', shops_nearby: nearby };
  if (recentlySearched(origin)) {
    return { status: nearby > 0 ? 'covered' : 'none_found', shops_nearby: nearby };
  }
  if (job && job.status === 'failed') {
    return { status: 'failed', shops_nearby: nearby, error: job.error };
  }
  return { status: 'not_covered', shops_nearby: nearby };
}

/** Start gathering for this point if it needs it. Returns the new coverage. */
function requestCoverage(origin) {
  const coverage = getCoverage(origin);
  if (coverage.status !== 'not_covered' && coverage.status !== 'failed') return coverage;

  if (Date.now() - dayStartedAt > 24 * 60 * 60 * 1000) {
    dayStartedAt = Date.now();
    jobsToday = 0;
  }
  if (jobsToday >= MAX_JOBS_PER_DAY || queue.length >= MAX_QUEUE) {
    return { status: 'busy', shops_nearby: coverage.shops_nearby };
  }

  jobsToday += 1;
  const key = cellKey(origin);
  jobs.set(key, { status: 'queued', origin });
  queue.push(key);
  drain();
  return { status: 'gathering', shops_nearby: coverage.shops_nearby };
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const key = queue.shift();
      const job = jobs.get(key);
      job.status = 'running';
      try {
        await gather(key, job.origin);
        jobs.delete(key); // done — coverage now comes from the catalogue itself
      } catch (err) {
        console.error(`areaCatalog: gathering ${key} failed:`, err);
        jobs.set(key, { status: 'failed', origin: job.origin, error: 'gathering_failed' });
      }
    }
  } finally {
    running = false;
  }
}

async function gather(key, origin) {
  const startedAt = Date.now();
  const log = (message) => console.log(`areaCatalog[${key}] ${message}`);

  log(`discovering shops within ${SEARCH_RADIUS_M / 1000}km`);
  const { shops } = await discoverShopsAt(origin, SEARCH_RADIUS_M, { log });

  // Skip shops we already have — no point re-crawling an overlapping area.
  const known = new Set(getCatalog().shops.map((s) => s.website));
  const candidates = shops.filter((s) => !known.has(s.website)).slice(0, MAX_SHOPS);
  log(`${shops.length} candidates with a website, trying ${candidates.length} new ones`);

  const { byShop } = await collectProducts(candidates, { log, concurrency: CONCURRENCY });
  const catalog = buildCatalog(candidates, byShop);

  // Written even when empty: an empty file is the record that we looked here,
  // so the next visitor gets "none_found" instead of another crawl.
  const record = {
    generated_at: new Date().toISOString(),
    // Rounded: this is a search area, not a record of where a user lives.
    origin: { lat: Number(origin.lat.toFixed(2)), lon: Number(origin.lon.toFixed(2)) },
    radius_m: SEARCH_RADIUS_M,
    ...catalog,
  };

  fs.mkdirSync(AREA_DIR, { recursive: true });
  const file = path.join(AREA_DIR, `${key}.json`);
  // Write-then-rename, so catalogStore never reads a half-written file.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);

  reload();
  log(
    `done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: ` +
      `${catalog.shops.length} shops, ${catalog.products.length} products`
  );
}

module.exports = { getCoverage, requestCoverage, NEAR_MILES };
