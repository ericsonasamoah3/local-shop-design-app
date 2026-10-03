// Rate limiting for the endpoints that cost money.
//
// /api/composite is unauthenticated and reachable from the internet, and every
// call spends Anthropic credits (the planning call) and Replicate credits (the
// generation). Without a limit, anyone who finds the address can run the bill
// up as fast as they can send requests.
//
// A fixed window per client, held in memory. Deliberately dependency-free and
// deliberately simple — it carries the same caveat as the job store in
// compositeService.js: the counters live in this process, so they reset on
// restart and each instance limits independently. That is the right trade at
// one task; put the counters in Redis before scaling out.
//
// This is a spend cap, not a security control. It does not replace putting
// real auth in front of the app.

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 20);

// One map per limiter, each key -> { count, resetAt }. Separate so that, say,
// postcode lookups never use up a client's composite allowance.
const allBuckets = new Set();

// Without this the map grows one entry per unique client, forever. Cleared on
// a timer rather than per-request so a flood cannot also drive the sweep.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const sweep = setInterval(() => {
  const now = Date.now();
  for (const buckets of allBuckets) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS);

// Never hold the process open for the sweeper alone.
if (typeof sweep.unref === 'function') sweep.unref();

/**
 * Who is calling.
 *
 * Every real request arrives through the frontend container's nginx, which
 * proxies /api/ to backend:3001 and sets X-Real-IP to the peer it saw
 * (frontend/nginx.conf). Without reading that header, req.ip would be nginx's
 * own address for ALL users and the whole internet would share one bucket.
 *
 * In AWS there is one more hop: API Gateway sits in front of nginx and passes
 * the visitor's IP in x-client-ip, which nginx swaps in as the peer address
 * before setting X-Real-IP (frontend/nginx.conf, terraform/https.tf).
 *
 * Trusting the header is safe only because nginx is the sole route in: the
 * frontend port admits only the API Gateway VPC link, and the backend port is
 * reachable only from inside the group. It is spoofable by anything that can
 * talk to :3001 directly, which under docker-compose means the local host —
 * acceptable for development, but revisit this if the backend is ever exposed.
 */
function clientKey(req) {
  const realIp = req.get('x-real-ip');
  if (realIp) return realIp.trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit({ windowMs = WINDOW_MS, max = MAX_REQUESTS } = {}) {
  const buckets = new Map();
  allBuckets.add(buckets);

  return (req, res, next) => {
    // 0 disables the limiter, which is what local development wants.
    if (max <= 0) return next();

    const now = Date.now();
    const key = clientKey(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      // 'rate_limited' is already in CompositePreview's ERROR_COPY, so this
      // surfaces as real copy rather than a generic failure.
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfter });
    }

    bucket.count += 1;
    return next();
  };
}

module.exports = { rateLimit, WINDOW_MS, MAX_REQUESTS };
