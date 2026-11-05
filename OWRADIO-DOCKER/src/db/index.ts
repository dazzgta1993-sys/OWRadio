/**
 * @file index.ts
 * @description SQLite database connection and self-bootstrapping schema initialization using built-in node:sqlite.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

// Ensure data directory exists
const dbDir = path.dirname(config.DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export class SQLiteWrapper {
  private db: DatabaseSync;

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
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: any[]) => stmt.run(...params),
      get: (...params: any[]) => stmt.get(...params),
      all: (...params: any[]) => stmt.all(...params),
    };
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const runInTx = (...args: Parameters<T>): ReturnType<T> => {
      this.db.exec('BEGIN TRANSACTION');
      try {
        const res = fn(...args);
        this.db.exec('COMMIT');
        return res;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
    return runInTx as T;
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

/**
 * Underlying SQLite database connection instance (powered by built-in node:sqlite).
 */
export const sqlite = new SQLiteWrapper(config.DATABASE_PATH);

// Optimize SQLite for high concurrency and write performance
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');

/**
 * Programmatically initialize database tables and indexes on application boot.
 * This ensures OWRadio is completely zero-config and self-bootstrapping without external CLI migration steps.
 */
function initSchema(): void {
  sqlite.exec(`
    -- Canonical songs table
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      deezer_id TEXT UNIQUE,
      youtube_id TEXT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      artist_id TEXT,
      album TEXT,
      duration_sec INTEGER NOT NULL,
      artwork_url TEXT,
      artwork_thumb_url TEXT,
      genre TEXT,
      release_year INTEGER,
      mood TEXT,
      energy_level INTEGER,
      ai_tags_json TEXT,
      created_at INTEGER NOT NULL
    );

    -- Playback history for 48h / 2h anti-repeat guardrails
    CREATE TABLE IF NOT EXISTS playback_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      played_at INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      is_manual_request INTEGER NOT NULL,
      completed INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_history_played_at ON playback_history(played_at);
    CREATE INDEX IF NOT EXISTS idx_history_song_played ON playback_history(song_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_history_artist_played ON playback_history(artist_name, played_at);

    -- User preference and taste affinity tracking
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      dislikes INTEGER NOT NULL DEFAULT 0,
      early_skips INTEGER NOT NULL DEFAULT 0,
      full_plays INTEGER NOT NULL DEFAULT 0,
      affinity_score REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_target_unique ON user_preferences(user_id, target_type, target_key);
    CREATE INDEX IF NOT EXISTS idx_pref_user_id ON user_preferences(user_id);
    CREATE INDEX IF NOT EXISTS idx_pref_affinity ON user_preferences(affinity_score);

    -- Short-lived stream cache (3-hour TTL)
    CREATE TABLE IF NOT EXISTS stream_cache (
      song_id TEXT PRIMARY KEY,
      youtube_id TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stream_cache_expires ON stream_cache(expires_at);

    -- Known Discord users and listener identities
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Permanently vetoed / blacklisted artists and songs
    CREATE TABLE IF NOT EXISTS vetoed_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'manual_admin',
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_veto_target_unique ON vetoed_catalog(target_type, target_key);

    -- Persistent bot state for auto-resume across restarts
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    `);

  // Non-destructive migrations for existing tables
  try {
    sqlite.exec(`ALTER TABLE songs ADD COLUMN detected_language TEXT;`);
  } catch {}
}

// Run bootstrapping immediately upon import
initSchema();

/**
 * Retrieves a string value from persistent bot_state table.
 */
export function getBotState(key: string, defaultValue = ''): string {
  try {
    const row = sqlite.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Persists a string value to bot_state table.
 */
export function setBotState(key: string, value: string): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare('INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now);
  } catch (err) {
    console.warn(`[BotState] Failed to persist key "${key}":`, (err as Error).message);
  }
}

export default sqlite;
