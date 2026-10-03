// Distance and place lookup for Phase 3's shop map.
//
// Shops already carry lat/lon from OpenStreetMap ingestion (discover/osm.js),
// so distance is pure arithmetic. The only network call is turning a typed
// postcode or town into coordinates, for users who decline the browser's
// location prompt.

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in miles. UK shoppers think in miles. */
function distanceMiles(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Parse a { lat, lon } pair from untrusted input. Returns null when either is
 * missing or out of range, so callers treat "no usable location" as one case.
 */
function parseLocation(lat, lon) {
  if (lat === undefined || lat === null || lat === '' || lon === undefined || lon === null || lon === '') {
    return null;
  }
  const parsed = { lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)) return null;
  if (Math.abs(parsed.lat) > 90 || Math.abs(parsed.lon) > 180) return null;
  return parsed;
}

function shopDistance(shop, origin) {
  if (!origin || typeof shop.lat !== 'number' || typeof shop.lon !== 'number') return null;
  // One decimal place: "2.4 miles" is useful, metre precision is noise.
  return Math.round(distanceMiles(origin, shop) * 10) / 10;
}

// --- Geocoding -------------------------------------------------------------
//
// Nominatim, the same service ingestion uses. Its usage policy asks for a real
// User-Agent, at most one request a second, and no autocomplete — so this is
// called once per submitted search, throttled globally, and cached.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT =
  process.env.GEOCODE_USER_AGENT ||
  'local-shop-design-app/0.1 (postcode lookup; +https://github.com/ericsonasamoah3/local-shop-design-app)';
const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 500;

const cache = new Map(); // normalised query -> result | null
let nextAllowedAt = 0;

async function waitForSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = Math.max(now, nextAllowedAt) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Look up a UK postcode or place name. Resolves to { lat, lon, label }, or
 * null when nothing matched. Throws 'geocoding_unavailable' when Nominatim
 * itself fails, so the caller can tell "no such place" from "try again".
 */
async function geocode(query) {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (cache.has(key)) return cache.get(key);

  await waitForSlot();

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  // The catalogue is UK-only, so a UK match is the only useful one.
  url.searchParams.set('countrycodes', 'gb');

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('geocoding_unavailable');
  }
  if (!response.ok) throw new Error('geocoding_unavailable');

  const results = await response.json().catch(() => null);
  if (!Array.isArray(results)) throw new Error('geocoding_unavailable');

  const first = results[0];
  const result = first
    ? { lat: Number(first.lat), lon: Number(first.lon), label: first.display_name }
    : null;

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

module.exports = { distanceMiles, parseLocation, shopDistance, geocode };
