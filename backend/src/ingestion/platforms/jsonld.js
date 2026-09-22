// schema.org JSON-LD fallback.
//
// For shops on neither Shopify nor WooCommerce. Almost every e-commerce
// platform embeds Product markup for Google Shopping, so reading that is far
// more durable than CSS selectors against a theme that changes. Still the
// slowest tier -- it costs one request per product page -- so it is bounded
// hard and only reached when the structured endpoints come back empty.

const { fetchText } = require('../http');
const { isAllowed } = require('../robots');

// One page per product adds up fast, so cap how deep we go into any one shop.
const MAX_PRODUCT_PAGES = Number(process.env.INGEST_MAX_JSONLD_PAGES || 40);
const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
const PRODUCT_PATH = /\/(product|products|shop|item)\//i;

function extractLocs(xml) {
  const locs = [];
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) locs.push(match[1]);
  return locs;
}

/** Walk a sitemap, following one level of sitemap-index nesting. */
async function collectProductUrls(origin) {
  for (const candidate of SITEMAP_CANDIDATES) {
    const url = `${origin}${candidate}`;
    if (!(await isAllowed(url))) continue;

    const xml = await fetchText(url, 'application/xml,text/xml');
    if (!xml) continue;

    const locs = extractLocs(xml);
    if (locs.length === 0) continue;

    const direct = locs.filter((u) => PRODUCT_PATH.test(u));
    if (direct.length > 0) return direct.slice(0, MAX_PRODUCT_PAGES);

    // A sitemap index: follow the child sitemaps that look product-shaped.
    const children = locs.filter((u) => /sitemap/i.test(u) && /product/i.test(u)).slice(0, 3);
    const gathered = [];

    for (const child of children) {
      if (!(await isAllowed(child))) continue;
      const childXml = await fetchText(child, 'application/xml,text/xml');
      if (!childXml) continue;
      gathered.push(...extractLocs(childXml).filter((u) => PRODUCT_PATH.test(u)));
      if (gathered.length >= MAX_PRODUCT_PAGES) break;
    }

    if (gathered.length > 0) return gathered.slice(0, MAX_PRODUCT_PAGES);
  }

  return [];
}

/** Pull every JSON-LD block out of a page, tolerating the malformed ones. */
function parseLdBlocks(html) {
  const blocks = [];
  const pattern = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Unescaped newlines in descriptions are common; skip rather than fail.
    }
  }

  return blocks;
}

function typesOf(node) {
  const raw = node['@type'];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((t) => String(t).toLowerCase());
}

/** Depth-first search for the first Product node, including inside @graph. */
function findProduct(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findProduct(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typesOf(node).includes('product')) return node;

  for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
    if (node[key]) {
      const found = findProduct(node[key], depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function firstOffer(product) {
  const offers = product.offers;
  if (!offers) return null;
  if (Array.isArray(offers)) return offers[0] || null;
  if (offers['@type'] && String(offers['@type']).toLowerCase() === 'aggregateoffer') {
    return { price: offers.lowPrice ?? offers.price, priceCurrency: offers.priceCurrency };
  }
  return offers;
}

function imageOf(product) {
  const image = product.image;
  if (!image) return null;
  const first = Array.isArray(image) ? image[0] : image;
  if (typeof first === 'string') return first;
  return first?.url || first?.contentUrl || null;
}

function toProduct(node, pageUrl) {
  const offer = firstOffer(node);
  const price = Number(offer?.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const availability = String(offer?.availability || '').toLowerCase();

  return {
    source: 'jsonld',
    external_id: String(node.sku || node.productID || node['@id'] || pageUrl),
    name: typeof node.name === 'string' ? node.name : '',
    description: String(node.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    price: Number(price.toFixed(2)),
    currency: offer?.priceCurrency || null,
    image_url: imageOf(node),
    product_url: pageUrl,
    // Absent availability is treated as sellable; only an explicit out-of-stock
    // marker takes a product out.
    in_stock: availability === '' ? true : !/outofstock|soldout|discontinued/.test(availability),
    raw_category: typeof node.category === 'string' ? node.category : '',
    tags: [],
  };
}

/** Returns null when nothing product-shaped could be found. */
async function fetchProducts(origin) {
  const urls = await collectProductUrls(origin);
  if (urls.length === 0) return null;

  const products = [];

  for (const url of urls) {
    if (!(await isAllowed(url))) continue;

    const html = await fetchText(url);
    if (!html) continue;

    for (const block of parseLdBlocks(html)) {
      const node = findProduct(block);
      if (!node) continue;
      const product = toProduct(node, url);
      if (product && product.name) {
        products.push(product);
        break;
      }
    }
  }

  return products.length > 0 ? products : null;
}

module.exports = { fetchProducts, parseLdBlocks, findProduct, toProduct, extractLocs };
