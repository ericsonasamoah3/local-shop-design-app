// Mapping arbitrary shop products onto this app's taxonomy.
//
// This is the real work of ingestion. A furniture shop's catalogue is mostly
// sofas; we want the handful of duvets, pillows and throws in it, tagged with
// a style the intake form understands. Two stages:
//
//   1. Keyword rules      - free, deterministic, and confident enough on their
//                           own for the large majority of clearly-named items.
//   2. Claude (optional)  - only for what the rules could not place, and only
//                           when a key is set. Mirrors the opt-in pattern in
//                           compositeService.js: better with a key, working
//                           without one.
//
// Precision matters more than recall here. A sofa mislabelled as a duvet
// reaches a real user as a bad suggestion; a duvet we skip costs nothing but a
// missed row.

const { z } = require('zod');

const CATEGORIES = ['duvet', 'pillow', 'throw'];
const STYLES = ['modern', 'rustic', 'minimalist'];

// Ordered: the first category whose pattern hits wins, so the more specific
// terms are listed above the looser ones.
// The s? matters: shops sell "Pillows 2 Pack" and "Downland Pillows 4 Pack",
// and a pattern written only for the singular drops both. It does not reopen
// the "Pillowcases" hole, since that has no word boundary after the optional s.
const CATEGORY_RULES = [
  { category: 'duvet', pattern: /\b(duvets?|comforters?|quilts?|bedding sets?|bed linen sets?)\b/i },
  { category: 'throw', pattern: /\b(throws?|blankets?|bedspreads?|coverlets?|afghans?)\b/i },
  { category: 'pillow', pattern: /\b(pillows?|cushions?|bolsters?|shams?)\b/i },
];

// Things that read as bedding but are not the item itself, in three groups.
// Note the trailing s? on the noun forms: without it "Pillowcases" slips past
// an exclusion written for "pillowcase".
const EXCLUSIONS = new RegExp(
  [
    // Accessories for the product rather than the product.
    'cover only|duvet covers?|pillow ?cases?|pillow ?slips?|protectors?|toppers?',
    // "Pillow top" is a mattress construction, not a pillow: it put two £540
    // Mattressman mattresses in the catalogue as premium pillows.
    'mattress|pillow ?top|valances?|fitted sheets?|curtains?|rugs?|lampshades?|candles?',
    'gift cards?|samples?|swatch',
    // Right noun, wrong room: a garden cushion or a travel pillow is not bedding.
    'garden|outdoor|patio|travel|neck|camping|inflatable|car |eye pillow|bolster pad',
    // Pet ranges use the same nouns and sit in the same catalogues.
    'pet|cat |cats |dog |dogs |puppy|kitten',
    // Consumables and household goods that happen to share a word.
    'treats?|food|shampoo|toilet roll|kitchen towel|bin bags?|corn pads?',
  ].join('|'),
  'i'
);

const STYLE_RULES = [
  { style: 'minimalist', pattern: /\b(minimal|minimalist|scandi|scandinavian|nordic|plain|simple)\b/i },
  { style: 'rustic', pattern: /\b(rustic|farmhouse|country|cottage|vintage|heritage|traditional|hygge)\b/i },
  { style: 'modern', pattern: /\b(modern|contemporary|geometric|sleek|urban|minimal luxe)\b/i },
];

/**
 * What the category is decided from: the product's own name plus the
 * department the shop filed it under.
 *
 * Deliberately NOT the description or tags. Matching those pulled in bin bags
 * whose blurb said "throw away", carpet shampoo, toilet roll ("Cushion Soft")
 * and cat treats ("Pillow Cat Treats") -- a marketing blurb mentions a word
 * for reasons that have nothing to do with what the product is.
 */
function categoryText(product) {
  return [product.name, product.raw_category].filter(Boolean).join(' ');
}

/** Style is a soft preference, so the looser text is fine for it. */
function styleText(product) {
  return [product.name, product.raw_category, (product.tags || []).join(' '), product.description]
    .filter(Boolean)
    .join(' ');
}

/** Rule-based pass. Returns { category, style } with nulls where unsure. */
function classifyByRules(product) {
  const subject = categoryText(product);

  if (EXCLUSIONS.test(subject)) return { category: null, style: null, reason: 'excluded' };

  const categoryHit = CATEGORY_RULES.find((rule) => rule.pattern.test(subject));
  const styleHit = STYLE_RULES.find((rule) => rule.pattern.test(styleText(product)));

  return {
    category: categoryHit ? categoryHit.category : null,
    style: styleHit ? styleHit.style : null,
    reason: categoryHit ? 'rules' : 'no_category_match',
  };
}

// --- Optional Claude pass ----------------------------------------------------

const CLASSIFY_MODEL = process.env.INGEST_CLASSIFY_MODEL || 'claude-haiku-4-5';
const BATCH_SIZE = Number(process.env.INGEST_CLASSIFY_BATCH || 40);

function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const ClassificationSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      category: z.enum(['duvet', 'pillow', 'throw', 'none']),
      style: z.enum(['modern', 'rustic', 'minimalist', 'unknown']),
    })
  ),
});

const SYSTEM_PROMPT = [
  'You classify retail products for a bedding recommendation app.',
  '',
  'For each numbered product decide:',
  '- category: "duvet" (duvet, comforter, quilt sold as the filled item or set),',
  '  "pillow" (pillow, cushion, bolster), "throw" (throw, blanket, bedspread),',
  '  or "none" for anything else.',
  '- style: "modern", "rustic", "minimalist", or "unknown" when nothing in the',
  '  text supports a choice.',
  '',
  'Return "none" whenever you are not confident the product IS the item itself.',
  'Covers, pillowcases, protectors, toppers and mattresses are "none" -- they are',
  'accessories, not the product being recommended. A wrong "duvet" reaches a real',
  'shopper as a bad suggestion; a missed one costs nothing. Prefer "none".',
].join('\n');

async function classifyBatchWithClaude(client, products) {
  const listing = products
    .map((p, i) => `${i}. ${p.name} | category: ${p.raw_category || 'n/a'} | ${(p.description || '').slice(0, 160)}`)
    .join('\n');

  const response = await client.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Classify these ${products.length} products.\n\n${listing}`,
      },
    ],
    tools: [
      {
        name: 'record_classifications',
        description: 'Record the classification for every product in the batch.',
        input_schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  category: { type: 'string', enum: ['duvet', 'pillow', 'throw', 'none'] },
                  style: { type: 'string', enum: ['modern', 'rustic', 'minimalist', 'unknown'] },
                },
                required: ['index', 'category', 'style'],
              },
            },
          },
          required: ['results'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'record_classifications' },
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) return [];

  const parsed = ClassificationSchema.safeParse(toolUse.input);
  return parsed.success ? parsed.data.results : [];
}

/**
 * Classify a list of raw products.
 *
 * Rules run on everything. Claude, when configured, only sees what the rules
 * could not place -- which keeps the token bill proportional to the genuinely
 * ambiguous tail rather than the whole catalogue.
 */
async function classifyProducts(products, { log = () => {} } = {}) {
  const classified = products.map((product) => ({ product, ...classifyByRules(product) }));

  const unresolved = classified.filter((c) => c.category === null && c.reason !== 'excluded');

  if (!claudeEnabled() || unresolved.length === 0) {
    if (unresolved.length > 0) {
      log(`  ${unresolved.length} products left unclassified (no ANTHROPIC_API_KEY -- rules only)`);
    }
    return classified.filter((c) => c.category !== null);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  log(`  asking ${CLASSIFY_MODEL} about ${unresolved.length} unclassified products`);

  for (let start = 0; start < unresolved.length; start += BATCH_SIZE) {
    const batch = unresolved.slice(start, start + BATCH_SIZE);

    let results = [];
    try {
      results = await classifyBatchWithClaude(client, batch.map((c) => c.product));
    } catch (err) {
      // A classification failure must not sink the run; these products simply
      // stay unclassified and drop out below.
      log(`  classification batch failed (${err.message}) -- continuing with rules only`);
      continue;
    }

    for (const result of results) {
      const target = batch[result.index];
      if (!target) continue;
      if (result.category === 'none') continue;
      target.category = result.category;
      target.style = result.style === 'unknown' ? null : result.style;
      target.reason = 'claude';
    }
  }

  return classified.filter((c) => c.category !== null);
}

module.exports = {
  classifyProducts,
  classifyByRules,
  claudeEnabled,
  CATEGORIES,
  STYLES,
};
