import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
// RENDER_EXTERNAL_URL is set automatically on Render, so short links get the public URL.
const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

const hops = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(hops) || hops < 0) {
  console.error('TRUST_PROXY must be a non-negative integer (number of proxies in front of the app).');
  process.exit(1);
}

const db = openDb();
const server = createApp(db, { baseUrl, trustProxy: hops || false }).listen(port, () => {
  console.log(`URL shortener listening on ${baseUrl}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
