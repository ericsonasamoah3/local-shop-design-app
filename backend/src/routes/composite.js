const express = require('express');
const { getProductById } = require('../services/suggestionEngine');
const { startComposite, getCompositeStatus } = require('../services/compositeService');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Only the POST is limited. GET /:id is how the frontend polls its own job —
// capping that would make a user's paid-for composite unreachable to them,
// which is the opposite of what the limit is for.
const compositeLimit = rateLimit();

// POST /api/composite — kicks off an async job, returns immediately.
// Request now requires mask_data (base64 data URI) since Phase 2 placement
// is user-drawn, not auto-detected. See CLAUDE.md Phase 2 section.
//
// Optional base_composite_id layers this item onto an earlier composite rather
// than the bare upload, so a user can furnish a scene one item at a time.
//
// Rate limited: this is the endpoint that spends Anthropic and Replicate
// credits, and it has no auth in front of it.
router.post('/', compositeLimit, async (req, res) => {
  const {
    upload_id: uploadId,
    product_id: productId,
    mask_data: maskDataUri,
    base_composite_id: baseCompositeId,
  } = req.body || {};

  if (!uploadId || !productId || !maskDataUri) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  const product = getProductById(productId);
  if (!product) {
    return res.status(404).json({ error: 'product_not_found' });
  }

  try {
    const result = startComposite({ uploadId, baseCompositeId, maskDataUri, product });
    res.status(202).json(result);
  } catch (err) {
    res.status(500).json({ error: 'compositing_failed' });
  }
});

// GET /api/composite/:id — frontend polls this until status is
// "complete" or "failed".
router.get('/:id', (req, res) => {
  const job = getCompositeStatus(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'composite_not_found' });
  }

  if (job.status === 'failed') {
    return res.status(200).json({
      composite_id: req.params.id,
      status: 'failed',
      error: job.error,
      notes: job.notes,
    });
  }

  if (job.status === 'processing') {
    return res.status(200).json({ composite_id: req.params.id, status: 'processing' });
  }

  res.status(200).json({
    composite_id: req.params.id,
    status: 'complete',
    composite_url: job.composite_url,
    // Additive optional fields. The Phase 1 contract shape is unchanged.
    notes: job.notes,
    base_composite_id: job.base_composite_id,
  });
});

module.exports = router;
