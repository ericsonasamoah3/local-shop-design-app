// WooCommerce adapter.
//
// The Store API (/wp-json/wc/store/v1/products) is public and read-only by
// design -- it is what the shop's own front end calls -- so no key is needed.
// Prices arrive as integer strings in minor units with the exponent alongside,
// which is the one real trap in this format.

const { fetchJson } = require('../http');
const { isAllowed } = require('../robots');

const PAGE_SIZE = 100; // Store API maximum
const MAX_PAGES = Number(process.env.INGEST_MAX_PAGES || 8);

// Older installs expose the unversioned path; try v1 first, then fall back.
const BASES = ['/wp-json/wc/store/v1/products', '/wp-json/wc/store/products'];

/**
 * "1299" with currency_minor_unit 2 means 12.99. The exponent varies by
 * currency (JPY uses 0), so it must be read rather than assumed.
 */
function priceOf(product) {
  const prices = product.prices || {};
  const raw = prices.price ?? prices.regular_price;
  if (raw === undefined || raw === null) return null;

  const minorUnit = Number(prices.currency_minor_unit ?? 2);
  const value = Number(raw) / 10 ** (Number.isFinite(minorUnit) ? minorUnit : 2);

  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
}

function plainDescription(product) {
  const html = product.short_description || product.description || '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

async function fetchPage(origin, base, page) {
  const url = `${origin}${base}?per_page=${PAGE_SIZE}&page=${page}`;
  if (!(await isAllowed(url))) return null;
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : null;
}

/** Returns null when this is not a WooCommerce store. */
async function fetchProducts(origin) {
  let base = null;
  let firstPage = null;

  for (const candidate of BASES) {
    const page = await fetchPage(origin, candidate, 1);
    if (page) {
      base = candidate;
      firstPage = page;
      break;
    }
  }

  if (!base || firstPage.length === 0) return null;

  const collected = [...firstPage];

  for (let page = 2; page <= MAX_PAGES; page += 1) {
    if (collected.length % PAGE_SIZE !== 0) break;
    const next = await fetchPage(origin, base, page);
    if (!next || next.length === 0) break;
    collected.push(...next);
  }

  return collected
    .map((product) => {
      const price = priceOf(product);
      if (price === null) return null;

      const images = Array.isArray(product.images) ? product.images : [];
      const categories = Array.isArray(product.categories) ? product.categories : [];

      return {
        source: 'woocommerce',
        external_id: String(product.id),
        name: product.name,
        description: plainDescription(product),
        price,
        currency: product.prices?.currency_code || null,
        image_url: images[0]?.src || null,
        product_url: product.permalink || origin,
        in_stock: product.is_in_stock !== false,
        raw_category: categories.map((c) => c.name).join(' / '),
        tags: [],
      };
    })
    .filter(Boolean);
}

module.exports = { fetchProducts, priceOf, plainDescription };
