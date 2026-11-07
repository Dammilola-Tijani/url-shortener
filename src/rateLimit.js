// Fixed-window, in-memory rate limiter keyed by client IP.
// Good enough for a single process; a multi-instance deployment would need a
// shared store (e.g. Redis) — see "Known limitations" in the README.
export function rateLimit({ max, windowMs }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically drop expired entries so the map can't grow forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, h);
    }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests, slow down.' });
    }
    next();
  };
}
