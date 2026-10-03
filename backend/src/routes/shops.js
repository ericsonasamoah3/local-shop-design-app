const express = require('express');
const { getCatalog } = require('../services/catalogStore');
const { parseLocation, shopDistance } = require('../services/geo');

const router = express.Router();

// GET /api/shops?lat=..&lon=.. — every shop in the catalogue, for the map.
// lat/lon are optional; with them each shop carries distance_miles and the
// list is nearest first.
router.get('/', (req, res) => {
  const origin = parseLocation(req.query.lat, req.query.lon);
  const { shops, products } = getCatalog();

  const productCounts = products.reduce((acc, p) => {
    acc[p.shop_id] = (acc[p.shop_id] || 0) + 1;
    return acc;
  }, {});

  const result = shops
    // A shop with no coordinates cannot go on a map. Ingestion records them
    // for every OSM shop, but the seed catalogue has none.
    .filter((shop) => typeof shop.lat === 'number' && typeof shop.lon === 'number')
    .map((shop) => ({
      shop_id: shop.id,
      name: shop.name,
      location: shop.location,
      source_type: shop.source_type,
      website: shop.website || null,
      lat: shop.lat,
      lon: shop.lon,
      product_count: productCounts[shop.id] || 0,
      distance_miles: shopDistance(shop, origin),
    }));

  if (origin) result.sort((a, b) => a.distance_miles - b.distance_miles);

  res.status(200).json({ shops: result });
});

module.exports = router;
