import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

const db = openDb();
const server = createApp(db, { baseUrl }).listen(port, () => {
  console.log(`URL shortener listening on ${baseUrl}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
