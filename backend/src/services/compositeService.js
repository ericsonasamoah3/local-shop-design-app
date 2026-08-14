const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// AI image editing via Replicate's FLUX Kontext Pro API. It accepts the room
// image plus an editing instruction. This gives new Replicate accounts a
// limited free trial, but does not support a mask or a product-image reference.
//
// This module keeps an in-memory job store (composite_id -> status/result).
// That's fine for local dev / a single backend instance, but won't survive
// a restart or work across multiple instances — swap for a real DB/queue
// (e.g. Redis) before this goes anywhere beyond your own machine.

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

const jobs = new Map(); // composite_id -> { status, composite_url, error }

function assertConfigured() {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('missing_replicate_token');
  }
}

function roomPhotoAsDataUri(uploadId) {
  const files = fs.readdirSync(UPLOAD_DIR);
  const match = files.find((f) => f.startsWith(uploadId));
  if (!match) throw new Error('upload_file_not_found');

  const filePath = path.join(UPLOAD_DIR, match);
  const ext = path.extname(match).replace('.', '') || 'jpeg';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
  return `data:${mime};base64,${base64}`;
}

function buildPrompt(product) {
  // Grounded in the product's own existing catalog data — not invented
  // freely. See CLAUDE.md: suggestions are always existing data, filtered,
  // never generated.
  const styleText = product.style && product.style !== 'any' ? `, ${product.style} style` : '';
  return `a ${product.name.toLowerCase()}${styleText}, realistic photo, natural lighting, placed naturally in the scene`;
}

async function createReplicatePrediction({ roomImageDataUri, product }) {
  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        input_image: roomImageDataUri,
        prompt: `Edit this room photo by adding ${buildPrompt(product)}. Keep the existing room composition, lighting, and all other furnishings unchanged.`,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`replicate_request_failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function pollPrediction(predictionId) {
  const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`replicate_poll_failed: ${response.status}`);
  }
  return response.json();
}

async function runCompositeJob(compositeId, { uploadId, maskDataUri, productImageUrl, product }) {
  try {
    assertConfigured();
    const roomImageDataUri = roomPhotoAsDataUri(uploadId);

    let prediction = await createReplicatePrediction({ roomImageDataUri, product });

    // Poll until the prediction leaves the queue. Replicate predictions are
    // async on their side too — this loop just waits for their job to
    // finish, separate from the polling your own frontend does against
    // GET /api/composite/:id.
    const POLL_INTERVAL_MS = 2000;
    const MAX_POLLS = 60; // ~2 minutes ceiling
    let pollCount = 0;

    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && pollCount < MAX_POLLS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      prediction = await pollPrediction(prediction.id);
      pollCount += 1;
    }

    if (prediction.status !== 'succeeded') {
      jobs.set(compositeId, { status: 'failed', error: prediction.error || 'timed_out' });
      return;
    }

    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    jobs.set(compositeId, { status: 'complete', composite_url: outputUrl });
  } catch (err) {
    jobs.set(compositeId, { status: 'failed', error: err.message });
  }
}

// Kicks off an async job and returns immediately with a "processing" status.
// Caller (routes/composite.js) is responsible for exposing GET /:id so the
// frontend can poll job status.
function startComposite({ uploadId, maskDataUri, productImageUrl, product }) {
  const compositeId = uuidv4();
  jobs.set(compositeId, { status: 'processing' });

  // Fire and forget — intentionally not awaited so the HTTP request returns
  // immediately with a 202.
  runCompositeJob(compositeId, { uploadId, maskDataUri, productImageUrl, product });

  return { composite_id: compositeId, status: 'processing' };
}

function getCompositeStatus(compositeId) {
  return jobs.get(compositeId) || null;
}

module.exports = { startComposite, getCompositeStatus };
