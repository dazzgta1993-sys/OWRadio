/**
 * @file db/index.ts
 * @description SQLite WAL database connection and schema bootstrapper using built-in node:sqlite.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const dbDir = path.dirname(config.DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export class SQLiteWrapper {
  private db: DatabaseSync;
  private stmtCache = new Map<string, any>();

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
  }

  pragma(str: string): void {
    try {
      this.db.exec(`PRAGMA ${str};`);
    } catch {}
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return {
      run: (...params: any[]) => stmt.run(...params),
      get: (...params: any[]) => stmt.get(...params) as Record<string, any> | undefined,
      all: (...params: any[]) => stmt.all(...params) as Record<string, any>[],
    };
  }

  close(): void {
    try {
      this.stmtCache.clear();
      this.db.close();
    } catch {}
  }
}

export const sqlite = new SQLiteWrapper(config.DATABASE_PATH);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');

function initSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'general',
      payload_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);

    CREATE TABLE IF NOT EXISTS stream_resolutions (
      cache_key TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      channel TEXT,
      match_type TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT 'global',
      track_id TEXT NOT NULL,
      video_id TEXT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      artwork_url TEXT,
      source TEXT,
      is_autoplay INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT,
      played_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_history_played_at ON playback_history(played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_guild_played ON playback_history(guild_id, played_at DESC);

    CREATE TABLE IF NOT EXISTS taste_feedback (
      guild_id TEXT NOT NULL DEFAULT 'global',
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      vote TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, entity_type, entity_key)
    );

    CREATE TABLE IF NOT EXISTS runtime_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

initSchema();

process.once('exit', () => sqlite.close());

export default sqlite;
