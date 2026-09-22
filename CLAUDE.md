# Local-Shop Design App — Phase 1 Build Spec

## Overview

An app where a user uploads a photo of an empty or unfinished space —
starting with a bed — and the app suggests real, purchasable items to
fill it in, sourced from local shops. Full concept covers multiple
categories (bedding, kitchen, party supplies, etc.) and eventually a
real AI-composited preview of the suggested item in the user's actual
photo. **Phase 1 scopes this down to a single category (bedding) with
a mocked composite step**, to validate the UX and data flow before
integrating a real inpainting model in Phase 2.

## Phase 1 goal

Prove the core loop's UX and data flow work end-to-end — upload,
suggest, preview — using a mocked composite response rather than real
AI image generation. Real compositing, and the product-viability
question it answers, is explicitly deferred to Phase 2 (see bottom of
this doc).

---

## 1. Project structure

Suggested layout — adapt to match whatever you already have running,
but keep this general shape so services stay clearly separated:

```
/
├── frontend/                 # React app
│   ├── src/
│   │   ├── components/       # UploadForm, IntakeForm, SuggestionList, CompositePreview
│   │   ├── api/               # thin API client wrapping fetch calls to backend
│   │   └── App.jsx
│   ├── nginx.conf             # must proxy /api/ AND wherever uploads/composites are served from
│   └── Dockerfile
├── backend/                  # Node/Express API
│   ├── src/
│   │   ├── routes/            # upload.js, suggest.js, composite.js
│   │   ├── services/          # suggestionEngine.js, compositeService.js (mocked in Phase 1)
│   │   ├── data/              # catalog.seed.json
│   │   └── server.js
│   ├── uploads/                # shared volume — must be mounted in both backend and frontend/nginx containers
│   └── Dockerfile
├── docker-compose.yml
└── CLAUDE.md
```

Key structural point carried over from the earlier upload-display
bug: whatever directory uploaded images and composites are written to
is mounted as a **host bind mount** (`./backend/uploads`,
`./backend/composites`), not a named Docker volume — this lets you
inspect files directly from your host filesystem while testing (e.g.
`ls backend/uploads`) without needing to exec into the container.
nginx proxies `/uploads/` and `/composites/` through to the backend
rather than serving files itself, so only the backend container needs
these mounted.

---

## 2. Intake form

Collected right after upload, before suggestions are generated.

| Field | Type | Values | Required |
|---|---|---|---|
| `space_type` | enum | `bedside_table`, `bed`, `bedroom_corner` | yes |
| `budget` | enum | `budget`, `mid`, `premium`, `any` | yes |
| `style` | enum | `modern`, `rustic`, `minimalist`, `any` | no |
| `occasion` | string (free text) | e.g. "just moved in" | no |

Enum-based fields (not free text) for `space_type`/`budget`/`style`
avoid needing an NLP parsing step in Phase 1.

---

## 3. API contracts

### `POST /api/upload`

**Request:** multipart/form-data, field `image` (jpg/png/webp, max 5MB)

**Response 200:**
```json
{
  "upload_id": "uuid",
  "image_url": "/uploads/{upload_id}.jpg",
  "created_at": "iso8601"
}
```

**Response 400:** `{ "error": "invalid_file_type" | "file_too_large" }`

Confirm `image_url` actually resolves in a browser before wiring the
frontend to it — this is the endpoint tied to the upload-display bug.

### `POST /api/suggest`

**Request:**
```json
{
  "upload_id": "uuid",
  "space_type": "bed",
  "budget": "mid",
  "style": "modern"
}
```

**Response 200:**
```json
{
  "suggestions": [
    {
      "product_id": "uuid",
      "name": "Linen Duvet Set",
      "price": 89.99,
      "price_tier": "mid",
      "shop_name": "Local Linen Co.",
      "shop_source_type": "local",
      "image_url": "https://...",
      "category": "duvet"
    }
  ]
}
```

Return 2-3 suggestions grouped by category (one duvet option, one
pillow option, one throw option for `space_type: bed`) — the frontend
needs to group by category, not render a flat undifferentiated list.

**Response 404:** `{ "error": "upload_not_found" }`
**Response 200, zero matches:** `{ "suggestions": [], "message": "no_matches_for_criteria" }` — this is an expected case, not an error; the frontend must handle it gracefully rather than showing a blank/broken state.

### `POST /api/composite` (mocked in Phase 1)

**Request:**
```json
{
  "upload_id": "uuid",
  "product_id": "uuid",
  "mask_data": "data:image/png;base64,...",
  "base_composite_id": "uuid | null"
}
```

`base_composite_id` is optional. When set, the item is composited onto
that earlier composite instead of the original upload, so a scene can
be built up one item at a time. When null, the upload is the base.

**Response 200:**
```json
{
  "composite_id": "uuid",
  "composite_url": "/composites/{composite_id}.jpg",
  "status": "complete"
}
```

In Phase 1, return a placeholder image — ideally something visually
distinguishable as a mock (e.g. a static "preview coming soon" overlay
on the uploaded photo, rather than an unrelated stock photo like
picsum.photos, which can be confused for a broken real feature).

Keep this response contract identical to what Phase 2's real
composite will return, so no frontend changes are needed when the
real integration replaces the mock.

**Response 500:** `{ "error": "compositing_failed" }` — the frontend must handle this explicitly rather than showing a broken image.

---

## 4. Mock catalog data

Seed file: `backend/src/data/catalog.seed.json`. Minimum for Phase 1:
2-3 items per category (duvet, pillow, throw) across price tiers.

```json
[
  {
    "id": "prod-bedding-1",
    "shop_id": "shop-1",
    "category": "duvet",
    "name": "Linen Duvet Set",
    "price": 89.99,
    "price_tier": "mid",
    "image_url": "...",
    "stock_status": "in_stock"
  }
]
```

Shops need at minimum `name`, `location`, `source_type: "local"` — to
support local-first ranking logic later, even though all mock shops
are marked local for now.

**This seed is now the fallback, not the source.** `catalogStore.js`
prefers a real ingested catalogue at `backend/catalog/catalog.json`
and drops back to the seed only when that file is missing or
unusable. The seed's `image_url`s are `placehold.co` placeholders, so
an app running on it is a demo: every suggestion is fake and every
composite paints a grey placeholder into someone's room. The backend
logs a warning on boot when it falls back, because the failure is
otherwise silent and looks like working software.

`backend/catalog/` **must stay committed.** It is generated, but it is
generated offline and identical for every instance, so it ships inside
the image rather than on a mounted volume. Leaving it untracked means
CI checks out a tree without it, the Docker build bakes nothing, and
production quietly serves the seed. See section 9.

---

## 5. Suggestion rules (Phase 1 — hardcoded, not ML)

For `space_type: bed`:
- Always suggest 1 item each from `duvet`, `pillow`, `throw` (skip a
  category if no catalog item exists for it — don't error).
- Filter by `price_tier` matching requested `budget`; if `budget:
  any`, return one option per tier instead of one item.
- If `style` is set, prefer matching-style items; fall back to any
  item in that price tier if no style match exists (style is a soft
  preference in Phase 1, not a hard filter).

For `space_type: bedside_table` / `bedroom_corner`: out of scope for
Phase 1 — stub to return `{ "suggestions": [], "message":
"category_coming_soon" }`.

---

## 6. Error handling checklist

- Upload: reject non-image and oversized files with clear codes.
- Suggest: handle zero-match cases without erroring.
- Composite: handle mock-failure cases (Phase 1) / real API
  failures-timeouts (Phase 2) gracefully — never leave the frontend
  with an infinite spinner or broken image and no explanation.
- Frontend: every API call needs a visible loading and error state,
  not just a happy-path render.

---

## 7. Acceptance criteria — Phase 1 is done when:

1. A user can upload a real photo of a bed and see it correctly
   displayed in the app (upload-display bug fixed, shared volume
   mounted correctly — see Project Structure).
2. Submitting the intake form returns real suggestions from the mock
   catalog, correctly filtered by budget and grouped by category.
3. Selecting a suggestion produces a mocked composite response that's
   visually clear it's a placeholder, not a broken feature.
4. Zero-match and mock-composite-failure cases are handled without
   crashing the frontend or leaving a broken/blank state.

Phase 1 validates UX and data flow only. It does not validate whether
AI compositing can produce convincing results — that's Phase 2.

---

## 8. Phase 2 — implemented

`/api/composite` returns a real composited image instead of a
placeholder. Claude plans the composite; a diffusion model renders it.

### Why the work is split

Claude is an image-**understanding** model — it takes images in and
returns text, and cannot generate, edit or manipulate an image. So it
does the thinking and a mask + reference-image inpainting model on
Replicate does the pixels. `compositeService.js` runs:

1. **Claude Opus 5 plans.** It sees the room photo, the product's own
   catalogue photo and the box the user drew, and returns a structured
   output: a refined `rect`, a `prompt` written from the lighting and
   surfaces it can actually see in *this* room, a `negative_prompt`, a
   `reference_strength`, a `plausible` flag and one line of `notes`.
2. **The plausibility gate.** If `plausible` is false the job ends
   there with an explanation. This is the main cost lever in the
   pipeline — the planning call is cents, a generation is not, and a
   duvet boxed onto the ceiling should never reach the model.
3. **Diffusion renders.** Claude's refined rect is rasterised back
   into a black/white mask and sent with the room photo, the product
   photo and the prompt to the Replicate model.
4. **The output is downloaded and written** to
   `composites/{composite_id}.jpg`. Replicate's delivery URLs expire,
   and section 3 promises a `/composites/` path, so we keep our own
   copy rather than handing on the CDN link.

- **Async contract.** `POST /api/composite` returns `202 processing`
  with a `composite_id`. `GET /api/composite/:id` polls job status
  (`processing` / `complete` / `failed`). `pollComposite()` on the
  frontend handles this on a fixed interval. The response also carries
  an optional `notes` string — additive; the Phase 1 shape is
  otherwise unchanged.

  **The two poll budgets are a pair — change one and change the
  other.** The frontend must outlast the backend's worst case, or it
  reports a timeout while the job carries on, succeeds and writes a
  composite nobody sees, which is money spent for nothing. Backend:
  planning (60s × 2 attempts) + `REPLICATE_MAX_POLLS` × 2s (180s) +
  overhead ≈ 300s. Frontend: 170 × 2s = 340s. Raising
  `REPLICATE_MAX_POLLS` or the Anthropic timeout/retries without
  raising `maxAttempts` reintroduces the bug.
- **Composites are layered, not one-shot.** Each result is a valid
  base for the next, via `base_composite_id`. The frontend keeps every
  version in a `layers` array and renders them as a timeline;
  selecting an earlier frame makes it the base again and truncates the
  versions after it, so the history stays linear. Without this the
  user was silently thrown back to the bare photo after every
  generation.
- **User-drawn mask, not auto-detection.** `MaskCanvas` lets the user
  drag a rough box over their photo. It renders to a black/white PNG
  (white = fill this area) sent as `mask_data`. The backend reduces it
  to the bounding box of the white area, which is what Claude refines.
  Auto-detection is a future upgrade — placement risk and compositing
  risk were deliberately kept separate.
- **Whether the product's real appearance survives depends on the
  model you configure.** With a mask + reference model, the catalogue
  photo goes in as the reference image and the actual item is what
  gets rendered. With a mask-only model (flux-fill-pro, Ideogram),
  blank `REPLICATE_FIELD_REFERENCE` — the model then never sees the
  product and generates a generic item from Claude's description
  instead. That is a real weakening of the "real, purchasable item"
  premise, so prefer a reference-capable model where you can, and know
  which mode you are in when judging criterion 2.
- **In-memory job store.** Job status lives in a `Map` in
  `compositeService.js` — fine for a single instance, but it does not
  survive a restart or scale across instances. Swap for Redis or a
  DB-backed queue before this goes beyond your own machine.

### Configuration

`REPLICATE_API_TOKEN` and `REPLICATE_MODEL_VERSION` are required.
`ANTHROPIC_API_KEY` is **optional** — see root `.env.example` and
`backend/.env.example`.

**Claude is opt-in.** With a key set, it plans each composite as
described above. With no key the backend takes the rectangle the user
drew as-is and builds the prompt from catalogue fields the way Phase 1
did, skipping the planning call entirely. You lose rect refinement,
room-aware prompting and the plausibility gate; you pay nothing per
composite. Terraform mirrors this: leave `anthropic_api_key` empty and
the SSM parameter, the task secret and the IAM grant are all omitted.

Note that the Claude API is billed per token and is a separate product
from a Claude Pro/Max subscription, which cannot be used from an app.
`ANTHROPIC_MODEL` selects the planning model (default
`claude-opus-5`); `claude-haiku-4-5` is roughly 5x cheaper and handles
this bounded task well.

Two things vary by model and are therefore **not** hardcoded:

- **Which model to run.** `REPLICATE_MODEL_VERSION` takes either an
  `owner/name` slug for an official hosted model (these have no public
  version hash and are called on a different endpoint) or a 64-hex
  version hash for a pinned community model. The right endpoint is
  chosen from the shape of the value. Hashes change over time — take
  the current one from the model's Replicate page right before use.
- **The input field names.** One model's `ip_adapter_image` is
  another's `image_prompt` or `reference_image`. The defaults are
  `image` / `mask` / `prompt` / `negative_prompt` /
  `ip_adapter_image`, each overridable via `REPLICATE_FIELD_*`. Check
  the schema on your model's page and override what does not match —
  this is the first thing to look at if generations fail.

### Cost

Every composite costs one Claude planning call plus, if it passes the
gate, one generation. The generation dominates. The levers, in order
of effect:

- `MAX_RENDER_EDGE` (default 1024) caps the room photo before
  rendering. Generation cost and latency scale with pixel count, so
  this is the biggest single knob.
- The plausibility gate stops doomed requests before the expensive
  call.
- Images are downscaled to 1024px before reaching Claude, and the
  system prompt is cached, so the planning call stays small.

### Acceptance criteria — Phase 2

1. ✅ A real composite image is returned end-to-end through the async
   flow, served from `/composites/{id}.jpg` by the backend.
2. ⏳ **Untested — this is the whole point of the phase.** "A person
   shown the image without context believes it's a real photo of the
   room with that item in it" can only be judged by running real
   photos through a configured model. Check it against several, not
   one cherry-picked example.
3. ✅ Failure and timeout cases are handled gracefully. Missing
   config (`missing_anthropic_key`, `missing_replicate_token`,
   `missing_replicate_model_version`), unreadable or empty mask,
   unavailable product image, model errors, render timeout and poll
   timeout each surface a specific message. `CompositePreview` maps
   every backend error code to human copy; verified end to end via
   the `missing_anthropic_key` path.
4. ⏳ **The decision this phase exists to inform.** If criterion 2
   comes back inconsistent or unconvincing once real testing happens,
   this is the point to revisit whether Option B (AI compositing) is
   viable as the primary approach, or whether Option A (3D/Unreal)
   needs to move up the roadmap — before investing further in UX
   built on the photorealism assumption.

### Known gaps, deliberately not addressed here

- `/api/composite` is unauthenticated, and spends both Anthropic and
  Replicate credits per call, on a task exposed directly to the
  internet. It is now rate limited — `middleware/rateLimit.js`, 20
  POSTs per client per hour by default, tunable via `RATE_LIMIT_MAX`
  and `RATE_LIMIT_WINDOW_MS`, and `RATE_LIMIT_MAX=0` disables it for
  local testing. That is a **spend cap, not auth**: the counters live
  in the process, so they reset on restart and each instance limits
  independently, and the client is identified by the `X-Real-IP` nginx
  sets (trustworthy only while nginx is the sole route to the
  backend). Narrowing `frontend_allowed_cidrs` to your own IP is still
  the stronger control, and real auth is still missing.
- There is no load balancer and no certificate, so the app is HTTP-only
  and reachable at the frontend task's current public IP, which changes
  on every deployment. `terraform output app_url_command` prints the
  command that resolves it. The ALB was dropped for cost; reintroducing
  it means restoring a second AZ in `availability_zones`.
- Nothing prunes `uploads/` or `composites/` on EFS.
- There are no tests. `suggestionEngine` is pure and is the cheapest
  place to start.

---

## 9. Catalogue ingestion

Where real products come from. Run by hand, offline — it is not part
of the request path, so a slow or hostile shop can never affect a
user, and it costs nothing beyond bandwidth.

```
node src/ingestion/run.js --place "Biggleswade, UK" --radius 25000
```

Flags: `--place`, `--radius`, `--out`, `--max-shops` (default 40),
`--dry-run`. Output is `backend/catalog/catalog.json`, which the API
reads at boot via `catalogStore.js` (section 4).

### The pipeline

1. **Discover** — `discover/osm.js`. Nominatim geocodes the place
   name; Overpass returns shop nodes/ways within the radius whose
   `shop` tag plausibly stocks bedding. Shops with no website are
   dropped, as are Facebook/Instagram links, since there is nothing
   to read. Public Overpass instances answer 429/504 routinely when
   busy, so three mirrors are tried in turn.
2. **Fetch** — `platforms/detect.js` tries three adapters cheapest
   first: Shopify (`/products.json`, one request to rule out, highest
   yield), WooCommerce (`/wp-json/wc/store/v1/products`, note prices
   arrive in minor units with the exponent alongside), then
   schema.org JSON-LD walked from the sitemap, which costs a request
   per product page and is therefore capped hard.
3. **Classify** — `normalize/classify.js`. Keyword rules first, free
   and deterministic. Claude (Haiku by default) sees only what the
   rules could not place — same opt-in pattern as compositing. The
   exclusion list is load-bearing and was built from real damage:
   "pillow top" put two £540 mattresses in as premium pillows, and
   matching descriptions rather than names pulled in bin bags
   ("throw away"), toilet roll ("Cushion Soft") and cat treats.
   Precision beats recall — a sofa mislabelled as a duvet reaches a
   shopper; a duvet missed costs nothing.
4. **Normalise** — `normalize/product.js` + `priceTier.js`. Products
   with no usable image, no name or an implausible price (< £1) are
   dropped. Tiers are per-category terciles over the actual
   distribution rather than fixed thresholds, so "budget" means cheap
   for what is genuinely available nearby.

Everything is polite by construction: `http.js` throttles per host,
identifies itself, times out and backs off on 429/5xx; `robots.js`
gates every shop request. Nominatim and Overpass are exempt — they
are APIs called on their documented terms, not sites being crawled.

### Known problems with the current pull

Measured against the committed catalogue (4 shops, 51 products):

- **`source_type: "local"` is asserted, not determined.** `osm.js`
  hardcodes it. Three of the four shops are national chains
  (Poundstretcher, Home Bargains, Dunelm). OSM's `brand` /
  `brand:wikidata` / `operator` tags are already in the response and
  would catch this.
- **One shop is 86% of the catalogue**, and `pickForCategory` returns
  `tierItems[0]` — catalogue order, i.e. ingestion order — so 8 of 9
  suggestions come from Poundstretcher. Tiers inherit the same skew:
  a "premium" throw is a £9.99 fleece.
- **The run leaves no artefact to analyse.** `run.js` builds a
  per-shop `report` and never writes it; `detect.js` discards the
  underlying error, so every unproductive shop reports the same
  `no_machine_readable_catalogue` whether it was a 403, a robots
  block or a DNS failure. Of ~40 candidates, 36 dropped out with no
  recoverable reason.
- **Style is close to inert** — 49/51 products have `style: null`,
  because Claude only ever sees products the category rules missed.
- Classifier leaks: `Baby Blanket` as a bed throw, cushion *pads*
  (inserts) as pillows.
- `stock_status` is never filtered when suggesting.
