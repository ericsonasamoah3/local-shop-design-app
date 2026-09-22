// Assembling the normalised catalogue.
//
// Takes discovered shops plus their classified products and emits exactly the
// shape catalog.seed.json already has, so suggestionEngine.js does not care
// which one it is reading. Extra fields (website, product_url, currency) are
// additive -- nothing downstream breaks on them, and the frontend needs
// product_url the moment "real, purchasable" is meant literally.

const crypto = require('crypto');

const { assignPriceTiers } = require('./priceTier');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
};

/**
 * Shop titles arrive HTML-encoded -- "Arm Knitting &#8211; Chunky Blanket" is
 * a real example. Decoded here so a product name never reaches a shopper with
 * an entity in it.
 */
function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable across runs: the same product keeps its id, so layers and links hold. */
function stableId(prefix, ...parts) {
  const hash = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

// Below this, a price is a placeholder rather than a price -- a workshop
// listing at £0.01, a "from" field the shop never filled in. Letting one
// through does more than show a silly number: it drags the budget percentile
// down and mislabels genuinely cheap items as mid.
const MIN_PLAUSIBLE_PRICE = 1;

function isPlausiblePrice(price) {
  return Number.isFinite(price) && price >= MIN_PLAUSIBLE_PRICE;
}

function isUsableImage(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * @param {Array} discovered  shops from discover/osm.js
 * @param {Map}   byShop      shop website -> classified products
 */
function buildCatalog(discovered, byShop) {
  const shops = [];
  const products = [];

  for (const shop of discovered) {
    const classified = byShop.get(shop.website);
    // A shop with nothing usable is left out entirely rather than shipped as an
    // empty storefront the suggestion engine would have to skip on every call.
    if (!classified || classified.length === 0) continue;

    const shopId = stableId('shop', shop.website);
    let kept = 0;

    for (const entry of classified) {
      const { product, category, style } = entry;

      // No photo means nothing to composite and nothing to show. This is the
      // filter that keeps the placehold.co problem from simply reappearing
      // with real shop names attached.
      if (!isUsableImage(product.image_url)) continue;
      if (!isPlausiblePrice(product.price)) continue;
      if (!product.name) continue;

      products.push({
        id: stableId('prod', shop.website, product.external_id),
        shop_id: shopId,
        category,
        name: decodeEntities(product.name),
        price: product.price,
        style: style || null,
        image_url: product.image_url,
        stock_status: product.in_stock ? 'in_stock' : 'out_of_stock',
        product_url: product.product_url,
        currency: product.currency || 'GBP',
        source: product.source,
      });
      kept += 1;
    }

    if (kept === 0) continue;

    shops.push({
      id: shopId,
      name: shop.name,
      location: shop.location,
      source_type: shop.source_type || 'local',
      website: shop.website,
      lat: shop.lat,
      lon: shop.lon,
    });
  }

  // Tiers are cut across the whole catalogue, not per shop -- "budget" should
  // mean cheap for the area, not cheap for whichever shop it came from.
  return { shops, products: assignPriceTiers(products) };
}

module.exports = { buildCatalog, stableId, isUsableImage, isPlausiblePrice, decodeEntities };
