# URL Shortener with Analytics

A small service that turns long URLs into short links, redirects visitors, and records click analytics (total clicks, clicks per day, top referrers).

Built with Node.js, Express, and SQLite (via Node's built-in `node:sqlite`). It's deliberately compact so the interesting parts like collision handling, safe redirects, and analytics queries are easy to follow.

## Quick start

Requires Node.js 22.5+ (uses the built-in `node:sqlite` and test runner).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

| Variable   | Default                 | Purpose                                     |
| ---------- | ----------------------- | ------------------------------------------- |
| `PORT`     | `3000`                  | HTTP port                                   |
| `BASE_URL` | `http://localhost:PORT` | Prefix used when building `shortUrl`        |
| `DB_FILE`  | `data.db`               | SQLite file path                            |

## API

| Method | Path                      | Description                                  |
| ------ | ------------------------- | -------------------------------------------- |
| POST   | `/api/links`              | Create a short link                          |
| GET    | `/:code`                  | Redirect (302) to the target and record a click |
| GET    | `/api/links/:code/stats`  | Click analytics for a link                   |
| DELETE | `/api/links/:code`        | Delete a link and its click history          |
| GET    | `/health`                 | Liveness check                               |

### Example

```bash
# Create (customCode and expiresAt are optional)
curl -X POST http://localhost:3000/api/links -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/long/path?x=1","expiresAt":"2030-01-01T00:00:00Z"}'
# → 201 {"code":"aB3dE9z","shortUrl":"http://localhost:3000/aB3dE9z","url":"...","expiresAt":"..."}

# Visit it (-i shows the 302 and Location header)
curl -i http://localhost:3000/aB3dE9z

# Analytics
curl http://localhost:3000/api/links/aB3dE9z/stats
```

Stats response:

```json
{
  "code": "aB3dE9z",
  "url": "https://example.com/some/long/path?x=1",
  "createdAt": "2024-03-10T12:00:00.000Z",
  "totalClicks": 3,
  "clicksPerDay": [{ "day": "2024-03-10", "clicks": 3 }],
  "topReferrers": [
    { "referrer": "https://news.example/post", "clicks": 2 },
    { "referrer": "(direct)", "clicks": 1 }
  ]
}
```

Status codes: `201` created, `302` redirect, `400` invalid input, `404` unknown code, `409` custom code taken, `410` link expired, `429` rate limited, `503` couldn't allocate a code.

## Problems I solved (and why)

### 1. Short-code collisions without a race condition
Codes are 7 random base62 characters (about 3.5 trillion combinations). Random codes can still collide, and the obvious fix has a bug:

```
if (!exists(code)) insert(code)   // two requests can both pass the check, then both insert
```

Instead, the code just **tries the insert and lets the `PRIMARY KEY` decide**. On a unique-constraint error it generates a new code and retries (up to 5 attempts, then `503`). The database enforces uniqueness atomically, so there's no window between check and insert.

I made the generator injectable so tests can force collisions deterministically: one test makes the generator return the same code twice and asserts the retry produces a new one; another forces every attempt to collide and asserts the `503`.

Codes are random rather than a sequential counter so links can't be enumerated by counting up.

### 2. Not becoming an open-redirect / XSS vector
A shortener that accepts any URL can be abused. The service only accepts `http:` and `https:` targets, so `javascript:` and `data:` URLs are rejected with `400`. URLs are parsed with the `URL` class rather than a regex, and length-capped at 2048. Custom codes are restricted to `[A-Za-z0-9_-]{3,32}` and can't collide with the service's own routes (`api`, `health`).

### 3. Counting clicks correctly: 302 vs 301
A `301` is cached by browsers, so repeat visits skip the server and the clicks are never counted. Redirects use **`302`** so every visit reaches the service. The trade-off is slightly more load per visit, which is acceptable for analytics.

### 4. Analytics queries that stay cheap
Clicks are stored one row per visit and aggregated at read time. A composite index on `(code, clicked_at)` serves the "clicks per day over the last 30 days" query, which always filters by one code and a time range. Referrers are grouped in SQL, with empty referrers shown as `(direct)`. Expired links return `410` and are **not** counted. Deleting a link cascades to its clicks.

### 5. Abuse protection
Link creation is rate limited per client IP (fixed window, `429` with a `Retry-After` header). The limiter prunes expired entries on a timer so its memory use stays bounded. Request bodies are capped at 10 KB.

## Design decisions and trade-offs

- **SQLite:** zero setup. The SQL is standard, so moving to Postgres is mostly a driver swap.
- **Synchronous click writes** in the redirect path. SQLite is fast enough here, but at scale I'd buffer clicks in memory or a queue and batch-insert them so redirects never wait on a write.
- **`node:sqlite`** avoids native compilation (a common pain on Windows). It is still marked experimental in Node.
- **No ORM:** prepared statements keep the SQL visible.

## Known limitations

- **In-memory rate limiter:** it resets on restart and isn't shared between instances. A multi-instance deployment needs a shared store such as Redis.
- **No authentication:** anyone can create a link, and anyone who knows a code can read its stats or delete it. A real service would tie links to accounts.
- **`trust proxy` is off**, so behind a reverse proxy every request would share one IP for rate limiting. It must be configured for the deployment.
- **No bot filtering:** crawlers and link previewers count as clicks.
- **No unique-visitor counting** (this would need a privacy-conscious approach).
- **No URL safety check** against known-malicious domains.

## Project layout

```
src/
  server.js     entry point, graceful shutdown
  app.js        routes, validation, redirect and analytics
  codes.js      random code generation, custom-code validation
  rateLimit.js  per-IP fixed-window limiter
  db.js         schema and indexes
test/
  app.test.js   end-to-end tests against an in-memory database
```
