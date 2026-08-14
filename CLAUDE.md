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
  "product_id": "uuid"
}
```

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

`/api/composite` now calls a real Replicate-hosted inpainting model
instead of returning a placeholder. Key differences from Phase 1:

- **Async contract.** `POST /api/composite` returns `202 processing`
  immediately with a `composite_id`. `GET /api/composite/:id` polls
  job status (`processing` / `complete` / `failed`). The frontend's
  `pollComposite()` handles this on a fixed interval.
- **User-drawn mask, not auto-detection.** The frontend's
  `MaskCanvas` component lets the user drag a rough box over their
  uploaded photo marking where the item goes. This gets rendered to a
  black/white PNG (white = fill this area) and sent as `mask_data`
  (base64 data URI) alongside the composite request. Auto-detection
  of placement area is a future upgrade, not part of this phase — see
  earlier discussion on why placement and compositing-quality risk
  were deliberately kept separate.
- **Image-conditioned, not text-only.** The prompt sent to the model
  is built from the product's existing catalog fields (name, style)
  in `buildPrompt()`, and the product's actual reference image is
  passed alongside it (field name depends on the specific model —
  check its Replicate schema). This preserves the real product's
  actual appearance rather than generating a generic reinterpretation
  from text alone.
- **Configuration required.** `REPLICATE_API_TOKEN` and
  `REPLICATE_MODEL_VERSION` must be set (see root `.env.example`) —
  the model version hash changes over time, so confirm the current
  one on the model's Replicate page before running this, don't trust
  a hardcoded value.
- **In-memory job store.** Composite job status is tracked in a
  `Map` in `compositeService.js` — fine for local dev/single-instance
  use, but won't survive a restart or scale across multiple backend
  instances. Swap for Redis or a DB-backed queue before this goes
  beyond your own machine.

### Acceptance criteria — Phase 2 is done when:

1. A real composite image (not a placeholder) is returned end-to-end
   through the async flow above.
2. That composite passes the quality bar: a person shown the image
   without context believes it's a real photo of the room with that
   item in it — checked against several real test photos, not just
   one cherry-picked example.
3. Failure/timeout cases (missing config, Replicate errors, polling
   timeout) are handled gracefully — confirmed working via the
   `missing_replicate_token` failure path during testing.
4. If output quality is inconsistent or unconvincing once real
   testing happens, this is the point to revisit whether Option B
   (AI compositing) is viable as the primary approach, or whether
   Option A (3D/Unreal) needs to move up the roadmap — before
   investing further in UX built around this assumption.
