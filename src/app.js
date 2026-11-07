import express from 'express';
import { generateCode as defaultGenerateCode, isValidCustomCode } from './codes.js';
import { rateLimit } from './rateLimit.js';

const MAX_URL_LENGTH = 2048;
const MAX_CODE_ATTEMPTS = 5;

const isUniqueViolation = (err) => /UNIQUE constraint failed/.test(err?.message ?? '');

// Only http(s) targets are allowed. Accepting arbitrary schemes would let someone
// create short links to javascript:/data: URLs, turning the service into an XSS vector.
function parseTargetUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function createApp(db, options = {}) {
  const {
    baseUrl = '',
    generateCode = defaultGenerateCode,
    createLimit = { max: 30, windowMs: 60_000 },
  } = options;

  const q = {
    insertLink: db.prepare('INSERT INTO links (code, url, expires_at) VALUES (?, ?, ?)'),
    getLink: db.prepare('SELECT code, url, created_at, expires_at FROM links WHERE code = ?'),
    deleteLink: db.prepare('DELETE FROM links WHERE code = ?'),
    insertClick: db.prepare('INSERT INTO clicks (code, referrer, user_agent) VALUES (?, ?, ?)'),
    total: db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE code = ?'),
    perDay: db.prepare(`
      SELECT substr(clicked_at, 1, 10) AS day, COUNT(*) AS clicks
      FROM clicks
      WHERE code = ? AND clicked_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      GROUP BY day ORDER BY day`),
    topReferrers: db.prepare(`
      SELECT COALESCE(NULLIF(referrer, ''), '(direct)') AS referrer, COUNT(*) AS clicks
      FROM clicks WHERE code = ?
      GROUP BY referrer ORDER BY clicks DESC, referrer LIMIT 5`),
  };

  const app = express();
  app.set('trust proxy', false);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---- Create ---------------------------------------------------------------
  app.post('/api/links', rateLimit(createLimit), (req, res) => {
    const { url, customCode, expiresAt } = req.body ?? {};

    const target = parseTargetUrl(url);
    if (!target) return res.status(400).json({ error: 'url must be a valid http(s) URL (max 2048 chars).' });

    let expires = null;
    if (expiresAt !== undefined && expiresAt !== null) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'expiresAt must be a valid date in the future.' });
      }
      expires = d.toISOString();
    }

    if (customCode !== undefined) {
      if (!isValidCustomCode(customCode)) {
        return res.status(400).json({ error: 'customCode must be 3-32 chars of letters, digits, _ or -, and not reserved.' });
      }
      try {
        q.insertLink.run(customCode, target, expires);
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ error: 'That code is already taken.' });
        throw err;
      }
      return res.status(201).json(linkResponse(customCode, target, expires));
    }

    // Random codes can collide. Rather than "check then insert" (which has a race
    // between the two statements), insert and let the PRIMARY KEY decide; retry on conflict.
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateCode();
      try {
        q.insertLink.run(code, target, expires);
        return res.status(201).json(linkResponse(code, target, expires));
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return res.status(503).json({ error: 'Could not allocate a short code, please retry.' });
  });

  function linkResponse(code, url, expiresAt) {
    return { code, shortUrl: `${baseUrl}/${code}`, url, expiresAt };
  }

  // ---- Stats ----------------------------------------------------------------
  app.get('/api/links/:code/stats', (req, res) => {
    const link = q.getLink.get(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found.' });
    res.json({
      code: link.code,
      url: link.url,
      createdAt: link.created_at,
      totalClicks: q.total.get(link.code).n,
      clicksPerDay: q.perDay.all(link.code),
      topReferrers: q.topReferrers.all(link.code),
    });
  });

  // ---- Delete ---------------------------------------------------------------
  app.delete('/api/links/:code', (req, res) => {
    const { changes } = q.deleteLink.run(req.params.code);
    if (!changes) return res.status(404).json({ error: 'Link not found.' });
    res.status(204).end();
  });

  // ---- Redirect -------------------------------------------------------------
  app.get('/:code', (req, res) => {
    const link = q.getLink.get(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found.' });
    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'This link has expired.' });
    }
    q.insertClick.run(link.code, req.get('referer') ?? null, (req.get('user-agent') ?? '').slice(0, 300) || null);
    // 302, not 301: browsers cache 301s forever, so repeat visits would skip us and never be counted.
    res.redirect(302, link.url);
  });

  // ---- Errors ---------------------------------------------------------------
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large.' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
