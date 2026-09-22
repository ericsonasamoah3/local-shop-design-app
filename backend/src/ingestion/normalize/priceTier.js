// Deriving budget / mid / premium from real prices.
//
// Not a model call and not a fixed threshold. Fixed thresholds go stale and do
// not travel between categories -- a "premium" pillow and a "premium" duvet are
// nowhere near the same number -- so tiers are cut from the actual distribution
// within each category. Tiers stay meaningful as the catalogue grows, and a
// shopper asking for "budget" gets the cheap third of what is genuinely
// available rather than whatever happened to fall under a hardcoded number.

const TIERS = ['budget', 'mid', 'premium'];

/** Linear-interpolated percentile over a sorted array. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Cut points for one category's prices.
 * Returns { p33, p67 } or null when there is too little data to split.
 */
function thresholdsFor(prices) {
  const sorted = [...prices].filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  // Below this, thirds are noise rather than signal.
  if (sorted.length < 3) return null;

  return { p33: percentile(sorted, 1 / 3), p67: percentile(sorted, 2 / 3) };
}

function tierFor(price, thresholds) {
  // With too few items to rank, calling everything "mid" is the honest answer:
  // it says nothing we cannot support rather than inventing a spread.
  if (!thresholds) return 'mid';
  if (price <= thresholds.p33) return 'budget';
  if (price <= thresholds.p67) return 'mid';
  return 'premium';
}

/**
 * Assign a price_tier to every product, computed per category.
 * Mutates nothing: returns a new array.
 */
function assignPriceTiers(products) {
  const byCategory = new Map();

  for (const product of products) {
    if (!byCategory.has(product.category)) byCategory.set(product.category, []);
    byCategory.get(product.category).push(product.price);
  }

  const thresholds = new Map();
  for (const [category, prices] of byCategory) {
    thresholds.set(category, thresholdsFor(prices));
  }

  return products.map((product) => ({
    ...product,
    price_tier: tierFor(product.price, thresholds.get(product.category)),
  }));
}

module.exports = { assignPriceTiers, thresholdsFor, tierFor, percentile, TIERS };
