// Where the catalogue comes from.
//
// Phase 1 read catalog.seed.json directly. Now an ingested catalogue, written
// by src/ingestion/run.js, takes precedence when one exists, and the seed is
// the fallback so the app still runs on a clean checkout with no ingestion yet.
//
// CATALOG_PATH points at the ingested file. It is NOT on a mounted volume:
// uploads/ and composites/ are written at runtime and need to outlive a task,
// but the catalogue is generated offline and is the same for every instance,
// so it ships inside the image. backend/catalog/ must therefore be committed —
// an untracked catalogue never reaches CI, the build bakes nothing, and the
// deployed app silently serves the placeholder seed instead.
//
// Set CATALOG_PATH to point somewhere else (a mount, a downloaded file) if you
// ever need to re-ingest without rebuilding.

const fs = require('fs');
const path = require('path');

const seed = require('../data/catalog.seed.json');

const CATALOG_PATH =
  process.env.CATALOG_PATH || path.join(__dirname, '..', '..', 'catalog', 'catalog.json');

let cached = null;

function isUsable(candidate) {
  return (
    candidate &&
    Array.isArray(candidate.products) &&
    Array.isArray(candidate.shops) &&
    candidate.products.length > 0
  );
}

function load() {
  try {
    if (fs.existsSync(CATALOG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      if (isUsable(parsed)) {
        return { ...parsed, source: 'ingested', path: CATALOG_PATH };
      }
      // Present but empty or malformed: fall through to the seed rather than
      // serving an app with no products at all.
      console.warn(`catalogStore: ${CATALOG_PATH} is unusable, falling back to seed`);
    } else {
      console.warn(`catalogStore: no ingested catalogue at ${CATALOG_PATH}`);
    }
  } catch (err) {
    console.warn(`catalogStore: could not read ${CATALOG_PATH} (${err.message}), using seed`);
  }

  return { ...seed, source: 'seed', path: null };
}

/** Cached after the first call; use reload() after a fresh ingestion. */
function getCatalog() {
  if (!cached) {
    cached = load();
    const count = cached.products.length;
    if (cached.source === 'seed') {
      // Worth shouting about: the seed's image_urls are placehold.co
      // placeholders, so every suggestion and every composite made from it is
      // a demo, not a real purchasable item.
      console.warn(
        `catalogStore: serving ${count} SEED products (placeholder images) — ` +
          'commit backend/catalog/catalog.json, or run src/ingestion/run.js'
      );
    } else {
      console.log(`catalogStore: loaded ${count} products from ${cached.source}`);
    }
  }
  return cached;
}

function reload() {
  cached = null;
  return getCatalog();
}

module.exports = { getCatalog, reload, CATALOG_PATH };
