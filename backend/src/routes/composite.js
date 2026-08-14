const express = require('express');
const { getProductById } = require('../services/suggestionEngine');
const { startComposite, getCompositeStatus } = require('../services/compositeService');

const router = express.Router();

// POST /api/composite — kicks off an async job, returns immediately.
// Request now requires mask_data (base64 data URI) since Phase 2 placement
// is user-drawn, not auto-detected. See CLAUDE.md Phase 2 section.
router.post('/', async (req, res) => {
  const { upload_id: uploadId, product_id: productId, mask_data: maskDataUri } = req.body || {};

  if (!uploadId || !productId || !maskDataUri) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  const product = getProductById(productId);
  if (!product) {
    return res.status(404).json({ error: 'product_not_found' });
  }

  try {
    const result = startComposite({
      uploadId,
      maskDataUri,
      productImageUrl: product.image_url,
      product,
    });
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
    return res.status(200).json({ composite_id: req.params.id, status: 'failed', error: job.error });
  }

  if (job.status === 'processing') {
    return res.status(200).json({ composite_id: req.params.id, status: 'processing' });
  }

  res.status(200).json({
    composite_id: req.params.id,
    status: 'complete',
    composite_url: job.composite_url,
  });
});

module.exports = router;
