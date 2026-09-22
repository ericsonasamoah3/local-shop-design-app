const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const { findUploadPath } = require('./uploadStore');

// Phase 2 compositing — Claude plans, a diffusion model renders.
//
// Claude is an image-*understanding* model: it takes images in and returns
// text, and cannot generate or edit an image. So it does the thinking, and a
// mask + reference-image inpainting model on Replicate does the pixels:
//
//   1. Claude sees the room photo, the product's catalogue photo and the box
//      the user drew. It returns a plan: a refined rectangle, a prompt written
//      from what it can actually see in the room, and a `plausible` flag.
//   2. If `plausible` is false we stop here. This gate is the main cost lever
//      in the pipeline — the Claude call is cents, a diffusion generation is
//      not, and a duvet boxed onto the ceiling should never reach the model.
//   3. Otherwise we build a mask from Claude's refined rect and send it, the
//      room photo, the product photo and the prompt to the diffusion model.
//   4. The output is downloaded and written to composites/{composite_id}.jpg,
//      so the URL we hand the frontend is ours and does not expire.
//
// Other cost levers, all deliberate: images are downscaled before they reach
// either model, the Claude system prompt is cached, and the room photo is
// capped at MAX_RENDER_EDGE before the diffusion call since generation cost
// scales with pixel count.
//
// Job status lives in an in-memory Map — fine for a single backend instance,
// but it does not survive a restart and does not work across instances. Swap
// for Redis or a DB-backed queue before this goes beyond your own machine.

const COMPOSITE_DIR = path.join(__dirname, '..', '..', 'composites');

// Claude is OPTIONAL. With a key set it plans the composite (refined rect,
// room-aware prompt, plausibility gate). Without one the job falls back to the
// user's own rectangle and a template prompt built from catalogue fields — the
// Phase 1 behaviour. The app works either way; the fallback is just less smart.
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Long edge we downscale to before sending images to Claude. The planning call
// only needs to judge placement, so 1024px is plenty and caps visual-token cost.
const ANALYSIS_LONG_EDGE = 1024;

// Long edge the room photo is capped at before the diffusion call. Generation
// cost and latency scale with pixel count, so this is the single biggest knob
// on what a composite costs.
const MAX_RENDER_EDGE = Number(process.env.MAX_RENDER_EDGE || 1024);

const REPLICATE_POLL_INTERVAL_MS = 2000;
const REPLICATE_MAX_POLLS = 90; // ~3 minutes

// Input field names differ between inpainting models on Replicate — one model's
// `ip_adapter_image` is another's `image_prompt` or `reference_image`. Rather
// than hardcode a guess, they are overridable. Check the schema on your model's
// Replicate page and set these if they don't match.
//
// Setting one to an empty string OMITS that field. Replicate rejects unknown
// input fields outright, so a mask-only model (flux-fill-pro, Ideogram) needs
// REPLICATE_FIELD_REFERENCE="" and usually REPLICATE_FIELD_NEGATIVE_PROMPT=""
// or every request 422s. See backend/.env.example.
function field(envName, fallback) {
  const value = process.env[envName];
  return value === undefined ? fallback : value.trim();
}

const FIELD = {
  image: field('REPLICATE_FIELD_IMAGE', 'image'),
  mask: field('REPLICATE_FIELD_MASK', 'mask'),
  prompt: field('REPLICATE_FIELD_PROMPT', 'prompt'),
  negativePrompt: field('REPLICATE_FIELD_NEGATIVE_PROMPT', 'negative_prompt'),
  reference: field('REPLICATE_FIELD_REFERENCE', 'ip_adapter_image'),
  referenceStrength: field('REPLICATE_FIELD_REFERENCE_STRENGTH', 'ip_adapter_weight'),
};

// True when the configured model can actually see the product photo. When it
// can't, the composite is generated from Claude's description alone and the
// real product's appearance is NOT preserved — see CLAUDE.md section 8.
const SENDS_REFERENCE = FIELD.reference !== '';

// Composites are chainable: the base for a job is either the original upload
// or an earlier composite, so a user can keep adding items to the same scene
// instead of starting from the bare room every time.
const COMPOSITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findCompositePath(compositeId) {
  if (typeof compositeId !== 'string' || !COMPOSITE_ID_PATTERN.test(compositeId)) return null;
  const candidate = path.join(COMPOSITE_DIR, `${compositeId}.jpg`);
  return fs.existsSync(candidate) ? candidate : null;
}

const jobs = new Map(); // composite_id -> { status, composite_url, notes, error }

let anthropic = null;

// Planning is a small, bounded call — one image pair and a short structured
// reply. A 120s timeout retried twice put the worst case at six minutes before
// rendering even started, which no browser waits for. 60s x 2 attempts keeps
// the whole job inside the frontend's poll budget (see pollComposite).
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('missing_anthropic_key');
  if (!anthropic) anthropic = new Anthropic({ timeout: 60000, maxRetries: 1 });
  return anthropic;
}

function assertReplicateConfigured() {
  if (!process.env.REPLICATE_API_TOKEN) throw new Error('missing_replicate_token');
  if (!process.env.REPLICATE_MODEL_VERSION) throw new Error('missing_replicate_model_version');
}

const CompositePlan = z.object({
  plausible: z
    .boolean()
    .describe('false if this rectangle cannot sensibly hold this kind of product'),
  notes: z.string().describe('One short sentence shown to the user under the preview.'),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .describe('The area to regenerate, in pixels on the room photo supplied to you.'),
  prompt: z
    .string()
    .describe('The prompt for the inpainting model describing what belongs in that area.'),
  negative_prompt: z.string().describe('What the model should avoid producing.'),
  reference_strength: z
    .number()
    .describe('0.0 to 1.0 — how closely the result should match the product photo.'),
});

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Reduces the mask PNG the browser drew to the bounding box of its white area.
// White means "put the product here" — see MaskCanvas on the frontend.
async function maskBoundingBox(maskDataUri, roomWidth, roomHeight) {
  if (typeof maskDataUri !== 'string') throw new Error('invalid_mask_data');
  const base64 = maskDataUri.split(',')[1];
  if (!base64) throw new Error('invalid_mask_data');

  const { data, info } = await sharp(Buffer.from(base64, 'base64'))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) throw new Error('empty_mask');

  // The mask is drawn at the photo's natural size, but rescale defensively in
  // case a client ever sends one at a different resolution.
  const scaleX = roomWidth / info.width;
  const scaleY = roomHeight / info.height;

  return {
    x: Math.round(minX * scaleX),
    y: Math.round(minY * scaleY),
    width: Math.round((maxX - minX + 1) * scaleX),
    height: Math.round((maxY - minY + 1) * scaleY),
  };
}

function clampRect(rect, width, height) {
  const w = Math.round(clamp(rect.width, 8, width));
  const h = Math.round(clamp(rect.height, 8, height));
  return {
    width: w,
    height: h,
    x: Math.round(clamp(rect.x, 0, width - w)),
    y: Math.round(clamp(rect.y, 0, height - h)),
  };
}

// Renders Claude's refined rectangle back into a black/white mask at the exact
// size of the image we send the model. White = regenerate this area.
async function buildMaskPng(rect, width, height) {
  const box = clampRect(rect, width, height);
  const white = await sharp({
    create: {
      width: box.width,
      height: box.height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([{ input: white, left: box.x, top: box.y }])
    .png()
    .toBuffer();
}

async function toJpegBuffer(buffer, longEdge) {
  return sharp(buffer)
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer();
}

function toDataUri(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function fetchProductImage(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`product_image_unavailable: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const SYSTEM_PROMPT = [
  'You are the art director for an interior-design preview tool.',
  'You are given a photo of a room, the catalogue photo of a real product a shopper wants to see in it, and the rectangle the shopper drew to mark where it should go.',
  'A separate inpainting model does the rendering. Your job is to decide the exact area it should regenerate and to write the prompt it works from.',
  'Write prompts from what you can actually see in the room photo — the light, its direction and warmth, the surfaces, the surrounding materials — combined with what the product actually is.',
  'Never invent product features that are not in the catalogue photo.',
  'All coordinates are pixels on the room photo you were given, with (0,0) at the top left.',
].join(' ');

function buildInstructions({ product, maskRect, roomWidth, roomHeight }) {
  const style = product.style && product.style !== 'any' ? `, ${product.style} style` : '';
  return [
    `The room photo is ${roomWidth} by ${roomHeight} pixels.`,
    `The shopper marked this area: x=${maskRect.x}, y=${maskRect.y}, width=${maskRect.width}, height=${maskRect.height}.`,
    `The product is a ${product.name}${style}, category "${product.category}".`,
    '',
    'Return a plan:',
    `- rect: refine the marked area so the item would sit naturally. Stay close to what the shopper drew, but correct it for the surface, the perspective and a realistic size for a ${product.category}. Include a little surrounding context so the model can blend edges. Keep it inside the photo.`,
    '- prompt: what the inpainting model should render in that area. Describe the product concretely, then the lighting and surface conditions you can see in this specific room so the result matches. Keep it under 60 words.',
    '- negative_prompt: artefacts to avoid — distorted geometry, duplicated objects, text, watermarks, and anything that would clash with this room.',
    '- reference_strength: how tightly to follow the product photo. Use 0.7 to 0.9 for items whose exact pattern matters, lower for plain textiles.',
    `- plausible: false if this area cannot sensibly hold a ${product.category} — for example it is on the ceiling, on a wall, or far too small. Be strict: a false here saves an expensive generation.`,
    '- notes: one short sentence for the shopper, in plain language. Say what you did, or why it will not work if plausible is false.',
  ].join('\n');
}

// The no-Claude path: trust the box the user drew and describe the product
// from the catalogue, the way Phase 1's buildPrompt did. No scene awareness
// and no plausibility gate, but no per-composite model cost either.
function buildTemplatePlan({ product, maskRect }) {
  const name = product.name.toLowerCase();
  // Catalogue names often already carry the style or the category
  // ("Minimalist Wool Throw"), so only prepend/append what would actually
  // tell the model something new.
  const hasStyle = product.style && product.style !== 'any' && !name.includes(product.style);
  const style = hasStyle ? `${product.style} ` : '';
  const category = name.includes(product.category) ? '' : `, ${product.category}`;
  return {
    plausible: true,
    notes: 'Placed exactly where you marked it.',
    rect: maskRect,
    prompt: `a ${style}${name}${category}, sitting naturally in the room, realistic materials, natural lighting consistent with the surrounding scene`,
    negative_prompt: 'distorted, duplicated objects, extra limbs, text, watermark, blurry, low quality',
    reference_strength: 0.8,
  };
}

async function requestCompositePlan({ roomBuffer, productBuffer, product, maskRect, roomWidth, roomHeight }) {
  const [roomPreview, productPreview] = await Promise.all([
    toJpegBuffer(roomBuffer, ANALYSIS_LONG_EDGE),
    toJpegBuffer(productBuffer, ANALYSIS_LONG_EDGE),
  ]);

  const response = await getAnthropic().messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    // The system prompt is byte-identical on every request, so caching it means
    // only the images and the per-request instructions are billed at full rate.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Room photo:' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: roomPreview.toString('base64') },
          },
          { type: 'text', text: 'Product catalogue photo:' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: productPreview.toString('base64') },
          },
          { type: 'text', text: buildInstructions({ product, maskRect, roomWidth, roomHeight }) },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(CompositePlan) },
  });

  if (response.stop_reason === 'refusal') throw new Error('placement_plan_refused');
  if (!response.parsed_output) throw new Error('placement_plan_unavailable');
  return response.parsed_output;
}

// Replicate has two prediction endpoints and which one you need depends on the
// kind of model. Community models are pinned to a 64-hex version hash and go to
// /v1/predictions; official hosted models (black-forest-labs/flux-fill-pro,
// ideogram-ai/..., etc.) have no public version hash and are called by slug on
// /v1/models/{owner}/{name}/predictions. REPLICATE_MODEL_VERSION accepts
// either form and we pick the right endpoint from its shape.
const VERSION_HASH = /^[0-9a-f]{64}$/i;

function predictionEndpoint() {
  const target = (process.env.REPLICATE_MODEL_VERSION || '').trim();
  if (VERSION_HASH.test(target)) {
    return { url: 'https://api.replicate.com/v1/predictions', versioned: true };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    return { url: `https://api.replicate.com/v1/models/${target}/predictions`, versioned: false };
  }
  throw new Error('invalid_replicate_model_version');
}

async function createPrediction(input) {
  const { url, versioned } = predictionEndpoint();
  const body = versioned
    ? { version: process.env.REPLICATE_MODEL_VERSION.trim(), input }
    : { input };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`replicate_request_failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function pollPrediction(predictionId) {
  const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
    headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`replicate_poll_failed: ${response.status}`);
  return response.json();
}

async function renderWithDiffusion({ roomJpeg, maskPng, productJpeg, plan }) {
  // Only send fields the configured model actually declares — Replicate
  // rejects the whole request if it sees an input it does not recognise.
  const input = {};
  const set = (name, value) => {
    if (name) input[name] = value;
  };

  set(FIELD.image, toDataUri(roomJpeg, 'image/jpeg'));
  set(FIELD.mask, toDataUri(maskPng, 'image/png'));
  set(FIELD.prompt, plan.prompt);
  set(FIELD.negativePrompt, plan.negative_prompt);

  if (SENDS_REFERENCE) {
    set(FIELD.reference, toDataUri(productJpeg, 'image/jpeg'));
    set(FIELD.referenceStrength, clamp(plan.reference_strength, 0, 1));
  }

  let prediction = await createPrediction(input);

  let polls = 0;
  while (
    prediction.status !== 'succeeded' &&
    prediction.status !== 'failed' &&
    prediction.status !== 'canceled' &&
    polls < REPLICATE_MAX_POLLS
  ) {
    await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_INTERVAL_MS));
    prediction = await pollPrediction(prediction.id);
    polls += 1;
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(prediction.error || (polls >= REPLICATE_MAX_POLLS ? 'render_timed_out' : 'render_failed'));
  }

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) throw new Error('render_returned_no_image');

  // Replicate's delivery URLs expire, and the API contract promises
  // /composites/{id}.jpg, so take a copy rather than handing the CDN link on.
  const download = await fetch(outputUrl);
  if (!download.ok) throw new Error(`render_download_failed: ${download.status}`);
  return Buffer.from(await download.arrayBuffer());
}

// Upstream SDK/HTTP errors become one of a small set of codes the frontend
// knows how to explain. Anything already thrown as a code by this module
// passes through unchanged.
const KNOWN_CODES = new Set([
  'missing_anthropic_key',
  'missing_replicate_token',
  'missing_replicate_model_version',
  'invalid_replicate_model_version',
  'upload_file_not_found',
  'base_composite_not_found',
  'unreadable_room_photo',
  'invalid_mask_data',
  'empty_mask',
  'placement_plan_refused',
  'placement_plan_unavailable',
  'render_timed_out',
  'render_failed',
  'render_returned_no_image',
]);

function toErrorCode(err) {
  const message = (err && err.message) || 'composite_failed';
  if (KNOWN_CODES.has(message)) return message;

  for (const prefix of ['product_image_unavailable', 'render_download_failed', 'replicate_']) {
    if (message.startsWith(prefix)) return prefix.replace(/_$/, '');
  }

  if (err && typeof err.status === 'number') {
    if (err.status === 401 || err.status === 403) return 'invalid_anthropic_key';
    if (err.status === 429) return 'rate_limited';
    if (err.status >= 500) return 'model_provider_unavailable';
  }
  return 'composite_failed';
}

async function runCompositeJob(compositeId, { uploadId, baseCompositeId, maskDataUri, product }) {
  try {
    // Fail before spending anything if the stack is not configured. Only the
    // renderer is mandatory — Claude is opt-in.
    assertReplicateConfigured();

    // Layer onto an earlier composite when one is named, otherwise start from
    // the original photo.
    const roomPath = baseCompositeId ? findCompositePath(baseCompositeId) : findUploadPath(uploadId);
    if (!roomPath) throw new Error(baseCompositeId ? 'base_composite_not_found' : 'upload_file_not_found');

    const roomBuffer = await fsp.readFile(roomPath);
    const productBuffer = await fetchProductImage(product.image_url);

    // Everything downstream works against the render-sized room photo, so
    // Claude's coordinates and the mask agree with what the model sees.
    const roomJpeg = await toJpegBuffer(roomBuffer, MAX_RENDER_EDGE);
    const { width: roomWidth, height: roomHeight } = await sharp(roomJpeg).metadata();
    if (!roomWidth || !roomHeight) throw new Error('unreadable_room_photo');

    const maskRect = await maskBoundingBox(maskDataUri, roomWidth, roomHeight);

    const plan = claudeEnabled()
      ? await requestCompositePlan({
          roomBuffer: roomJpeg,
          productBuffer,
          product,
          maskRect,
          roomWidth,
          roomHeight,
        })
      : buildTemplatePlan({ product, maskRect });

    // The cost gate. A finished job with an explanation, not a crash — the
    // frontend shows the note and the user can redraw.
    if (!plan.plausible) {
      jobs.set(compositeId, {
        status: 'failed',
        error: 'implausible_placement',
        notes: plan.notes,
      });
      return;
    }

    const [maskPng, productJpeg] = await Promise.all([
      buildMaskPng(plan.rect, roomWidth, roomHeight),
      toJpegBuffer(productBuffer, ANALYSIS_LONG_EDGE),
    ]);

    const rendered = await renderWithDiffusion({ roomJpeg, maskPng, productJpeg, plan });

    await fsp.mkdir(COMPOSITE_DIR, { recursive: true });
    await sharp(rendered)
      .jpeg({ quality: 90 })
      .toFile(path.join(COMPOSITE_DIR, `${compositeId}.jpg`));

    jobs.set(compositeId, {
      status: 'complete',
      composite_url: `/composites/${compositeId}.jpg`,
      notes: plan.notes,
      base_composite_id: baseCompositeId || null,
    });
  } catch (err) {
    // Log the full upstream error, but hand the client a stable short code.
    // Raw provider messages carry request ids and key hints that have no
    // business reaching a browser, and CompositePreview keys its copy off
    // these codes (CLAUDE.md section 6).
    console.error(`composite ${compositeId} failed:`, err);
    jobs.set(compositeId, { status: 'failed', error: toErrorCode(err) });
  }
}

// Kicks off an async job and returns immediately with a "processing" status.
// routes/composite.js exposes GET /:id so the frontend can poll it.
function startComposite({ uploadId, baseCompositeId, maskDataUri, product }) {
  const compositeId = uuidv4();
  jobs.set(compositeId, { status: 'processing', base_composite_id: baseCompositeId || null });

  // Fire and forget — intentionally not awaited so the HTTP request can return
  // 202 straight away.
  runCompositeJob(compositeId, { uploadId, baseCompositeId, maskDataUri, product });

  return { composite_id: compositeId, status: 'processing' };
}

function getCompositeStatus(compositeId) {
  return jobs.get(compositeId) || null;
}

module.exports = {
  startComposite,
  getCompositeStatus,
  // exported so the pure geometry can be exercised without hitting either API
  _internals: { maskBoundingBox, clampRect, buildMaskPng, renderWithDiffusion, buildTemplatePlan },
};
