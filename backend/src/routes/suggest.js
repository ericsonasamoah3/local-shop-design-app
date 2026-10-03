const express = require('express');
const { getSuggestions } = require('../services/suggestionEngine');
const { uploadExists } = require('../services/uploadStore');
const { parseLocation } = require('../services/geo');

const router = express.Router();

const VALID_SPACE_TYPES = ['bedside_table', 'bed', 'bedroom_corner'];
const VALID_BUDGETS = ['budget', 'mid', 'premium', 'any'];
const VALID_STYLES = ['modern', 'rustic', 'minimalist', 'any'];

router.post('/', (req, res) => {
  const { upload_id: uploadId, space_type: spaceType, budget, style, lat, lon } = req.body || {};

  if (!uploadId || !spaceType || !budget) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  if (!VALID_SPACE_TYPES.includes(spaceType)) {
    return res.status(400).json({ error: 'invalid_space_type' });
  }

  if (!VALID_BUDGETS.includes(budget)) {
    return res.status(400).json({ error: 'invalid_budget' });
  }

  if (style && !VALID_STYLES.includes(style)) {
    return res.status(400).json({ error: 'invalid_style' });
  }

  if (!uploadExists(uploadId)) {
    return res.status(404).json({ error: 'upload_not_found' });
  }

  // Optional. An absent or malformed location just means no distance
  // ranking — it is a nicety, not a reason to fail the request.
  const origin = parseLocation(lat, lon);

  const result = getSuggestions({ spaceType, budget, style: style || 'any', origin });

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.status(200).json(result);
});

module.exports = router;
