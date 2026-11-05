/**
 * @file config.ts
 * @description Centralized, schema-validated runtime configuration for VEXO.
 * Uses Zod to parse, validate, and provide strict type guarantees for environment variables.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env file into process.env
dotenv.config();

/**
 * Zod schema defining the environment contract for VEXO.
 */
const envSchema = z.object({
  /** Optional Discord Bot Authentication Token. If omitted, runs in Standalone Web Radio Mode. */
  DISCORD_TOKEN: z.string().optional(),

  /** Optional default Guild ID to bind to on startup. If omitted, the first cached guild is used. */
  DISCORD_CLIENT_ID: z.string().optional(),
  DEFAULT_GUILD_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),

  /** HTTP port for the embedded Hono web server (default: 8091) */
  WEB_PORT: z.coerce.number().default(8091),

  /** HTTP host address to bind Hono server to (default: 0.0.0.0 for external/VLC access) */
  WEB_HOST: z.string().default('0.0.0.0'),

  /** Optional public URL or domain (e.g. https://myradio.duckdns.org) for reverse proxy setups */
  PUBLIC_URL: z.string().default(''),

  /** Path to the SQLite WAL database file */
  DATABASE_PATH: z.string().default('./data/owradio.sqlite'),



  /** AI Curation Engine architecture: 'embedding' (Dense Vector), 'jev' (Discriminative Decision), 'llm' (Autoregressive), or 'hybrid' */
  CURATION_ENGINE: z.enum(['embedding', 'hybrid', 'graph', 'deezer']).default('hybrid'),

  /** Cooldown window in hours for song autoplay repetition (default: 48) */
  AUTOPLAY_COOLDOWN_HOURS: z.coerce.number().default(48),

  /** Cooldown window in hours before autoplaying the same artist (default: 2) */
  ARTIST_COOLDOWN_HOURS: z.coerce.number().default(2),

  /** Optional Spotify Client ID for enhanced link resolution */
  SPOTIFY_CLIENT_ID: z.string().optional(),

  /** Optional Spotify Client Secret */
  SPOTIFY_CLIENT_SECRET: z.string().optional(),

  /** Optional Last.fm API Key for collaborative human listening graph */
  LASTFM_API_KEY: z.string().optional(),

  /** Optional YouTube Proof of Origin (POT) token to bypass datacenter throttling */
  YOUTUBE_POT_TOKEN: z.string().optional(),

  /** Optional SOCKS5 or HTTP proxy URL for yt-dlp (e.g. socks5://127.0.0.1:40000 for Cloudflare WARP) */
  YOUTUBE_PROXY: z.string().optional(),

  /** Optional path to Netscape cookies file for yt-dlp */
  YOUTUBE_COOKIES_PATH: z.string().optional(),

  /** Automatically remove YouTube dialogue/skits/credits using SponsorBlock (default: true) */
  ENABLE_SPONSORBLOCK: z.coerce.boolean().default(true),

  /** Automatically trim dead-air silence from track intros using FFmpeg (default: true) */
  ENABLE_SILENCE_TRIMMING: z.coerce.boolean().default(true),

  /** Silence threshold in dBFS for lead-in and outro detection (default: -46) */
  SILENCE_THRESHOLD_DB: z.coerce.number().default(-46),

  /** Duration of trailing outro silence in seconds before triggering early crossfade (default: 1.5) */
  OUTRO_SILENCE_TRIGGER_SEC: z.coerce.number().default(1.5),

  /** Automatically resume Discord voice playback on bot restart without requiring /play (default: true) */
  AUTO_RESUME: z.coerce.boolean().default(true),

  /** Optional default voice channel ID to join on auto-resume if no previous state exists */
  DEFAULT_VOICE_CHANNEL_ID: z.string().optional(),
  DEFAULT_TEXT_CHANNEL_ID: z.string().optional(),

  /** Delay in seconds after Discord gateway ready before initiating auto-resume (default: 2) */
  AUTO_RESUME_DELAY_SEC: z.coerce.number().default(2),

  // --- Double Authentication System ---
  /** Master Authentication switch for Web Dashboard controls & settings */
  AUTH_ENABLED: z.coerce.boolean().optional(),

  /** Tier 1: Simple Admin Password for Web Dashboard management */
  ADMIN_PASSWORD: z.string().optional(),

  /** Tier 2: Optional Supabase Project URL for Google OAuth integration */
  SUPABASE_URL: z.string().optional(),

  /** Tier 2: Optional Supabase Anon/Public Key for Google OAuth integration */
  SUPABASE_ANON_KEY: z.string().optional(),

  /** Optional Supabase JWT Secret for token verification */
  SUPABASE_JWT_SECRET: z.string().optional(),

  /** Secret key used to sign HMAC session tokens */
  SESSION_SECRET: z.string().default('owradio_hmac_secret_token_default_2026'),
});

/**
 * Validated configuration object inferred from envSchema.
 */
export type Config = z.infer<typeof envSchema>;

/**
 * Parse and freeze configuration. Throws on validation failure with formatted error list.
 */
function loadConfig(): Config {
  if (process.env.DISCORD_GUILD_ID && !process.env.DEFAULT_GUILD_ID) {
    process.env.DEFAULT_GUILD_ID = process.env.DISCORD_GUILD_ID;
  }
  if (process.env.DEFAULT_GUILD_ID && !process.env.DISCORD_GUILD_ID) {
    process.env.DISCORD_GUILD_ID = process.env.DEFAULT_GUILD_ID;
  }
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join('.')}: ${error.message}`);
    }
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const config = loadConfig();
export default config;
