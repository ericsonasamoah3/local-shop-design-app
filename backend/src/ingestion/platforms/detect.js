// Which platform is this shop on?
//
// Tried cheapest-and-most-structured first. Shopify and WooCommerce each cost
// one request to rule out and give a clean, complete catalogue when they hit.
// JSON-LD is last because it costs a request per product page.

const shopify = require('./shopify');
const woocommerce = require('./woocommerce');
const jsonld = require('./jsonld');

const ADAPTERS = [
  { name: 'shopify', fetchProducts: shopify.fetchProducts },
  { name: 'woocommerce', fetchProducts: woocommerce.fetchProducts },
  { name: 'jsonld', fetchProducts: jsonld.fetchProducts },
];

/**
 * Pull whatever this shop exposes.
 *
 * Resolves to { platform, products } or { platform: null, products: [], reason }
 * -- a shop with nothing machine-readable is an ordinary outcome here, not an
 * error, so one dead site cannot end a whole run.
 */
async function fetchShopProducts(origin) {
  for (const adapter of ADAPTERS) {
    let products;
    try {
      products = await adapter.fetchProducts(origin);
    } catch (err) {
      // A malformed response from one platform should still let the next be
      // tried, so failures are recorded rather than thrown.
      products = null;
    }

    if (products && products.length > 0) {
      return { platform: adapter.name, products };
    }
  }

  return { platform: null, products: [], reason: 'no_machine_readable_catalogue' };
}

module.exports = { fetchShopProducts, ADAPTERS };
