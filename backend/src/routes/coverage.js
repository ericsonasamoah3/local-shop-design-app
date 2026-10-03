const express = require('express');
const { getCoverage, requestCoverage } = require('../services/areaCatalog');
const { parseLocation } = require('../services/geo');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Starting a crawl is the expensive call, so only POST is limited. Polling
// with GET is free and must stay so, or a user waiting on their own area
// would be cut off from finding out it finished.
const startLimit = rateLimit({ max: Number(process.env.COVERAGE_RATE_LIMIT_MAX || 5) });

function originFrom(source) {
  return parseLocation(source.lat, source.lon);
}

// GET /api/coverage?lat=..&lon=.. — do we have shops near here? No side effects.
router.get('/', (req, res) => {
  const origin = originFrom(req.query);
  if (!origin) return res.status(400).json({ error: 'invalid_location' });
  res.status(200).json(getCoverage(origin));
});

// POST /api/coverage { lat, lon } — same answer, but if nobody has looked
// here yet, start gathering shops around this point in the background.
router.post('/', startLimit, (req, res) => {
  const origin = originFrom(req.body || {});
  if (!origin) return res.status(400).json({ error: 'invalid_location' });
  res.status(200).json(requestCoverage(origin));
});

module.exports = router;
