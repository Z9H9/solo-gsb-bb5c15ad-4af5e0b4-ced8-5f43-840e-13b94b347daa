'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DRAWS_TABLE = `
  CREATE TABLE IF NOT EXISTS draws (
    id              TEXT PRIMARY KEY,
    mode            TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'multiparty')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'revealed')),
    commitment      TEXT NOT NULL,
    seed            TEXT NOT NULL,
    nonce           TEXT,
    candidates      TEXT NOT NULL,
    draw_count      INTEGER NOT NULL,
    result          TEXT,
    created_at      TEXT NOT NULL,
    revealed_at     TEXT,
    protocol_version INTEGER NOT NULL DEFAULT 2,
    snapshot_digest TEXT
  );
`;

const PARTICIPANTS_TABLE = `
  CREATE TABLE IF NOT EXISTS participants (
    draw_id      TEXT NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    name         TEXT NOT NULL,
    commitment   TEXT,
    secret       TEXT,
    committed_at TEXT,
    revealed_at  TEXT,
    PRIMARY KEY (draw_id, name)
  );
`;

const PARTICIPANTS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_participants_draw_position
    ON participants (draw_id, position);
`;

// v1 databases predate the 'committed' phase and the participants table.
// SQLite cannot alter a CHECK constraint in place, so the draws table has to
// be recreated; existing rows keep their (single-party) semantics.
function migrateV0ToV1(db) {
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'draws'"
  ).get();
  if (ddl && ddl.sql.includes("'committed'")) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec('ALTER TABLE draws RENAME TO draws_legacy;');
  db.exec(DRAWS_TABLE);
  db.exec(`
    INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates,
                       draw_count, result, created_at, revealed_at,
                       protocol_version, snapshot_digest)
    SELECT id, 'single', status, commitment, seed, nonce, candidates,
           draw_count, result, created_at, revealed_at, 1, NULL
      FROM draws_legacy;
  `);
  db.exec('DROP TABLE draws_legacy;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// v1 -> v2: persist the protocol version and the v2 candidate-snapshot digest
// alongside every draw. New draws are v2; existing rows stay NULL-digest v1
// and keep being verified with the legacy commitment SHA-256(seed).
function migrateV1ToV2(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(draws)').all().map((c) => c.name)
  );
  if (!columns.has('protocol_version')) {
    // Constant default makes the ADD COLUMN legal for non-empty tables.
    db.exec('ALTER TABLE draws ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;');
  }
  if (!columns.has('snapshot_digest')) {
    db.exec('ALTER TABLE draws ADD COLUMN snapshot_digest TEXT;');
  }
}

// Opens (creating if needed) the SQLite database and ensures the schema exists.
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Contending BEGIN IMMEDIATE transactions wait for the write lock instead
  // of failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000;');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(DRAWS_TABLE);
  if (version < 1) {
    migrateV0ToV1(db);
    db.exec('PRAGMA user_version = 1;');
  }
  if (version < 2) {
    // A v0->v1 rebuild above already carries the v2 columns; this only adds
    // them to databases that already existed at v1.
    migrateV1ToV2(db);
    db.exec('PRAGMA user_version = 2;');
  }
  db.exec(PARTICIPANTS_TABLE);
  db.exec(PARTICIPANTS_INDEX);
  return db;
}

module.exports = { openDatabase };
