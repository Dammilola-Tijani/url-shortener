import { DatabaseSync } from 'node:sqlite';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function openDb(file = process.env.DB_FILE || 'data.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS links (
      code        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (${NOW}),
      expires_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL REFERENCES links(code) ON DELETE CASCADE,
      clicked_at  TEXT NOT NULL DEFAULT (${NOW}),
      referrer    TEXT,
      user_agent  TEXT
    );

    -- Stats queries always filter by code and a time range.
    CREATE INDEX IF NOT EXISTS idx_clicks_code_time ON clicks (code, clicked_at);
  `);
  return db;
}
