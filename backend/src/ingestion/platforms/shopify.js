// Shopify adapter.
//
// Every Shopify storefront serves /products.json unauthenticated. It is the
// single highest-yield source in this pipeline: structured, paginated, stable
// across theme changes, and it carries the product image and stock flag we
// need without touching a single line of HTML.

const { fetchJson } = require('../http');
const { isAllowed } = require('../robots');

const PAGE_SIZE = 250; // Shopify's maximum
const MAX_PAGES = Number(process.env.INGEST_MAX_PAGES || 8);

function priceOf(product) {
  // Variants carry the price, not the product. The cheapest in-stock variant
  // is the honest "from" price to show a shopper.
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const prices = variants
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  return prices.length > 0 ? Math.min(...prices) : null;
}

function inStock(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (variants.length === 0) return true; // no variant data: assume sellable
  return variants.some((v) => v.available !== false);
}

function imageOf(product) {
  const images = Array.isArray(product.images) ? product.images : [];
  const src = images[0]?.src || product.image?.src || null;
  if (!src) return null;
  return src.startsWith('//') ? `https:${src}` : src;
}

/** Strip Shopify's HTML body down to something a classifier can read. */
function plainDescription(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Probe a site for Shopify and pull its catalogue.
 * Returns null when this is not a Shopify store, so detect.js can move on.
 */
async function fetchProducts(origin) {
  const first = `${origin}/products.json?limit=${PAGE_SIZE}&page=1`;
  if (!(await isAllowed(first))) return null;

  const probe = await fetchJson(first);
  // A non-Shopify site returns HTML, a 404, or JSON without `products`.
  if (!probe || !Array.isArray(probe.products)) return null;

  const collected = [...probe.products];

  for (let page = 2; page <= MAX_PAGES; page += 1) {
    if (collected.length % PAGE_SIZE !== 0) break; // last page was short
    const url = `${origin}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    if (!(await isAllowed(url))) break;

    const next = await fetchJson(url);
    if (!next || !Array.isArray(next.products) || next.products.length === 0) break;
    collected.push(...next.products);
  }

  return collected
    .map((product) => {
      const price = priceOf(product);
      if (price === null) return null;

      return {
        source: 'shopify',
        external_id: String(product.id),
        name: product.title,
        description: plainDescription(product.body_html),
        price,
        currency: null, // /products.json omits it; resolved from the shop later
        image_url: imageOf(product),
        product_url: `${origin}/products/${product.handle}`,
        in_stock: inStock(product),
        raw_category: product.product_type || '',
        tags: Array.isArray(product.tags) ? product.tags : String(product.tags || '').split(/,\s*/),
      };
    })
    .filter(Boolean);
}

module.exports = { fetchProducts, priceOf, inStock, plainDescription };
