const express = require('express');
const { geocode } = require('../services/geo');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Free to us, but Nominatim is a shared public service with a usage policy,
// so one client should not be able to hammer it through us. Separate from the
// composite allowance.
const geocodeLimit = rateLimit({ max: Number(process.env.GEOCODE_RATE_LIMIT_MAX || 30) });

// GET /api/geocode?q=SG18 8AA — postcode or town to coordinates. The fallback
// for users who decline the browser's location prompt, or whose browser
// cannot give one. The location is used for this request only, never stored.
router.get('/', geocodeLimit, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!query) return res.status(400).json({ error: 'missing_query' });
  if (query.length > 100) return res.status(400).json({ error: 'query_too_long' });

  try {
    const result = await geocode(query);
    if (!result) return res.status(404).json({ error: 'location_not_found' });
    res.status(200).json(result);
  } catch (err) {
    console.error('geocode failed:', err.message);
    res.status(502).json({ error: 'geocoding_unavailable' });
  }
});

module.exports = router;
