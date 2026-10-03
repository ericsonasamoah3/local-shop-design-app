// Shop discovery via OpenStreetMap.
//
// Answers "which shops near here might sell bedding" without an API key and
// without a bill, which is why it is the default over Google Places. Two
// public services, used as documented rather than crawled:
//
//   Nominatim  - turns "Biggleswade, UK" into a lat/lon
//   Overpass   - returns OSM shop nodes/ways within a radius of it
//
// Both ask for a real User-Agent and roughly one request a second; http.js
// already throttles harder than that. They are APIs we are calling on their
// documented terms, so the robots.txt gate in robots.js is applied to the shop
// websites we go on to read, not to these two endpoints.

const { fetchJson, USER_AGENT, sleep } = require('../http');

const NOMINATIM = process.env.INGEST_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';

// The public Overpass instances are free, heavily shared, and routinely answer
// 504 or 429 when busy -- that is normal operation, not an outage. Mirrors are
// tried in turn before giving up. INGEST_OVERPASS_URL pins a single endpoint.
const OVERPASS_MIRRORS = process.env.INGEST_OVERPASS_URL
  ? [process.env.INGEST_OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ];

// OSM shop values plausibly stocking duvets, pillows or throws. Deliberately
// broad: a department store or a general houseware shop often carries bedding
// even though nothing in the tag says so. The platform probe that follows is
// cheap, and shops with no usable product endpoint drop out there anyway.
const SHOP_TAGS = [
  'bed',
  'furniture',
  'houseware',
  'interior_decoration',
  'curtain',
  'fabric',
  'department_store',
  'variety_store',
];

/** Geocode a free-text place name. Returns { lat, lon, displayName } or null. */
async function geocode(place) {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(place)}&format=json&limit=1`;
  const results = await fetchJson(url);
  if (!Array.isArray(results) || results.length === 0) return null;

  const [first] = results;
  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    displayName: first.display_name,
  };
}

function buildQuery(lat, lon, radiusMetres) {
  const filter = `"shop"~"^(${SHOP_TAGS.join('|')})$"`;
  const around = `(around:${radiusMetres},${lat},${lon})`;
  // `out center` gives ways a representative coordinate without their nodes.
  return [
    '[out:json][timeout:60];',
    '(',
    `  node[${filter}]${around};`,
    `  way[${filter}]${around};`,
    ');',
    'out center tags;',
  ].join('\n');
}

/**
 * POST a query to Overpass, walking the mirrors on failure.
 *
 * Overpass takes the query in a POST body, which politeFetch (GET only) does
 * not cover, so this call is made directly -- still identifying itself and
 * still bounded by a timeout.
 */
async function queryOverpass(query, { log = () => {} } = {}) {
  const body = new URLSearchParams({ data: query });
  const failures = [];

  for (const endpoint of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body,
          // Overpass is slow under load and the query allows 60s server-side.
          signal: AbortSignal.timeout(90000),
        });

        if (result.ok) return await result.json();

        failures.push(`${endpoint} -> ${result.status}`);
        // 429/504 mean "busy, come back"; anything else will not improve on a
        // retry against the same mirror.
        if (result.status !== 429 && result.status !== 504) break;
        log(`  overpass ${result.status} from ${new URL(endpoint).host}, retrying`);
        await sleep(3000 * (attempt + 1));
      } catch (err) {
        failures.push(`${endpoint} -> ${err.message}`);
        break;
      }
    }
  }

  throw new Error(`overpass_unavailable (${failures.join('; ')})`);
}

/** Normalise the various ways OSM records a website. */
function websiteOf(tags) {
  const raw = tags.website || tags['contact:website'] || tags.url || null;
  if (!raw) return null;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    // Facebook pages and the like are common in OSM and useless to us: they
    // have no product endpoint to probe.
    if (/facebook\.|instagram\.|twitter\.|linkedin\./i.test(parsed.host)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function addressOf(tags, fallbackArea) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
    tags['addr:postcode'],
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : fallbackArea;
}

/**
 * Find candidate shops around a place.
 *
 * @param {string} place        free text, e.g. "Biggleswade, UK"
 * @param {number} radiusMetres search radius
 * @returns {Promise<{ origin, area, shops: Array }>}
 */
async function discoverShops(place, radiusMetres = 25000, { log = () => {} } = {}) {
  const location = await geocode(place);
  if (!location) throw new Error(`could_not_geocode: ${place}`);

  return discoverShopsAt(location, radiusMetres, { log, area: place });
}

/**
 * Find candidate shops around a point we already have — a user's location,
 * when the app gathers shops on demand (services/areaCatalog.js).
 *
 * @param {{ lat: number, lon: number, displayName?: string }} location
 */
async function discoverShopsAt(location, radiusMetres = 25000, { log = () => {}, area = null } = {}) {
  const data = await queryOverpass(buildQuery(location.lat, location.lon, radiusMetres), { log });

  const seen = new Set();
  const shops = [];

  for (const element of data.elements || []) {
    const tags = element.tags || {};
    if (!tags.name) continue;

    const website = websiteOf(tags);
    // No website means nothing to ingest from. Kept out rather than carried
    // through the pipeline as a shop with zero products.
    if (!website) continue;
    if (seen.has(website)) continue;
    seen.add(website);

    shops.push({
      osm_id: `${element.type}/${element.id}`,
      name: tags.name,
      website,
      shop_tag: tags.shop,
      location: addressOf(tags, location.displayName),
      lat: element.lat ?? element.center?.lat ?? null,
      lon: element.lon ?? element.center?.lon ?? null,
      source_type: 'local',
    });
  }

  return { origin: location, area: area || location.displayName || null, shops };
}

module.exports = { discoverShops, discoverShopsAt, geocode, websiteOf, buildQuery, SHOP_TAGS };
