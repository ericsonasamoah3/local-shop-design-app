// Thin wrapper around the backend API. Kept separate from components so the
// contract lives in one place — matches CLAUDE.md section 3 exactly.

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'upload_failed');
  }
  return data;
}

// location is optional — { lat, lon } ranks suggestions nearest shop first
// and adds distance_miles to each.
export async function getSuggestions({ uploadId, spaceType, budget, style, location }) {
  const response = await fetch('/api/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_id: uploadId,
      space_type: spaceType,
      budget,
      style,
      lat: location ? location.lat : undefined,
      lon: location ? location.lon : undefined,
    }),
  });

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'suggest_failed');
  }
  return data;
}

// baseCompositeId layers onto an earlier composite instead of the original
// upload, so the user can keep building on the scene they've already made.
export async function createComposite({ uploadId, productId, maskDataUri, baseCompositeId }) {
  const response = await fetch('/api/composite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_id: uploadId,
      product_id: productId,
      mask_data: maskDataUri,
      base_composite_id: baseCompositeId || null,
    }),
  });

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'composite_failed');
  }
  return data; // { composite_id, status: 'processing' }
}

export async function getCompositeStatus(compositeId) {
  const response = await fetch(`/api/composite/${compositeId}`);
  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'composite_status_failed');
  }
  return data; // { status: 'processing' | 'complete' | 'failed', composite_url?, error? }
}

// Polls until the composite job leaves "processing". Simple fixed-interval
// polling — fine for Phase 2's scale, swap for something smarter (backoff,
// websockets) if this becomes a bottleneck later.
//
// maxAttempts MUST outlast the backend's own worst case, or we tell the user
// it timed out while the job carries on, succeeds and writes a composite
// nobody ever sees — which is money spent for nothing. The backend budget is
// planning (60s x 2 attempts) + render (REPLICATE_MAX_POLLS x 2s = 180s)
// + overhead, so ~300s. 170 x 2s = 340s clears it with margin.
// See compositeService.js for the other half of this pair.
export async function pollComposite(compositeId, { intervalMs = 2000, maxAttempts = 170 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await getCompositeStatus(compositeId);
    if (result.status !== 'processing') return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('composite_timed_out');
}

// Every shop with coordinates, for the map. With a location, nearest first
// and each carries distance_miles.
export async function getShops(location) {
  const params = location ? `?lat=${location.lat}&lon=${location.lon}` : '';
  const response = await fetch(`/api/shops${params}`);
  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'shops_failed');
  }
  return data; // { shops: [...] }
}

// Postcode or town to { lat, lon, label } — the fallback when the browser
// cannot or may not share the user's location.
export async function geocode(query) {
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  const data = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(data?.error || 'geocoding_unavailable');
  }
  return data;
}
