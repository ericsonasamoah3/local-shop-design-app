// Fetch and classify products for a list of discovered shops.
//
// Shared by run.js (by hand, offline) and services/areaCatalog.js (on demand,
// around a user's location). Several shops are worked on at once: http.js
// throttles per HOST, so concurrency across different shops stays polite to
// each of them while cutting the wall-clock time a user waits.

const { fetchShopProducts } = require('./platforms/detect');
const { classifyProducts } = require('./normalize/classify');

/**
 * @returns {Promise<{ byShop: Map<string, Array>, report: Array }>}
 *   byShop is keyed by shop website, as normalize/product.js buildCatalog expects.
 */
async function collectProducts(candidates, { log = () => {}, concurrency = 1 } = {}) {
  const byShop = new Map();
  const report = [];
  let next = 0;

  async function worker() {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      const shop = candidates[index];
      const label = `[${index + 1}/${candidates.length}] ${shop.name}`;

      let result;
      try {
        result = await fetchShopProducts(shop.website);
      } catch (err) {
        log(`${label} -- failed: ${err.message}`);
        report.push({ shop: shop.name, platform: null, raw: 0, kept: 0, note: err.message });
        continue;
      }

      if (!result.platform) {
        log(`${label} -- no machine-readable catalogue, skipped`);
        report.push({ shop: shop.name, platform: null, raw: 0, kept: 0, note: result.reason });
        continue;
      }

      const classified = await classifyProducts(result.products, { log });
      log(`${label} -- ${result.platform}: ${result.products.length} products, ${classified.length} bedding`);

      byShop.set(shop.website, classified);
      report.push({
        shop: shop.name,
        platform: result.platform,
        raw: result.products.length,
        kept: classified.length,
      });
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, worker);
  await Promise.all(workers);

  return { byShop, report };
}

module.exports = { collectProducts };
