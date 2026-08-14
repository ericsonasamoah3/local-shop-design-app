const catalog = require('../data/catalog.seed.json');

// Phase 1: hardcoded rules, not ML. See CLAUDE.md section 5.

const CATEGORIES_BY_SPACE_TYPE = {
  bed: ['duvet', 'pillow', 'throw'],
  // Out of scope for Phase 1 — stubbed to return "category_coming_soon".
  bedside_table: [],
  bedroom_corner: [],
};

function shopById(shopId) {
  return catalog.shops.find((s) => s.id === shopId);
}

function pickForCategory(category, budget, style) {
  const itemsInCategory = catalog.products.filter((p) => p.category === category);
  if (itemsInCategory.length === 0) return [];

  if (budget === 'any') {
    // One option per tier.
    const tiers = ['budget', 'mid', 'premium'];
    return tiers
      .map((tier) => {
        const tierItems = itemsInCategory.filter((p) => p.price_tier === tier);
        if (tierItems.length === 0) return null;
        const styleMatch = tierItems.find((p) => p.style === style);
        return styleMatch || tierItems[0];
      })
      .filter(Boolean);
  }

  const tierItems = itemsInCategory.filter((p) => p.price_tier === budget);
  if (tierItems.length === 0) return [];

  // Style is a soft preference — prefer a match, fall back to any item in the tier.
  const styleMatch = style && style !== 'any'
    ? tierItems.find((p) => p.style === style)
    : null;

  return [styleMatch || tierItems[0]];
}

function getSuggestions({ spaceType, budget, style }) {
  const categories = CATEGORIES_BY_SPACE_TYPE[spaceType];

  if (categories === undefined) {
    return { error: 'invalid_space_type' };
  }

  if (categories.length === 0) {
    return { suggestions: [], message: 'category_coming_soon' };
  }

  const suggestions = categories.flatMap((category) => {
    const picks = pickForCategory(category, budget, style);
    return picks.map((product) => {
      const shop = shopById(product.shop_id);
      return {
        product_id: product.id,
        name: product.name,
        price: product.price,
        price_tier: product.price_tier,
        shop_name: shop ? shop.name : 'Unknown shop',
        shop_source_type: shop ? shop.source_type : 'unknown',
        image_url: product.image_url,
        category: product.category,
      };
    });
  });

  if (suggestions.length === 0) {
    return { suggestions: [], message: 'no_matches_for_criteria' };
  }

  return { suggestions };
}

function getProductById(productId) {
  return catalog.products.find((p) => p.id === productId) || null;
}

module.exports = { getSuggestions, getProductById };
