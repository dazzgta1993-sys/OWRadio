/**
 * @file config.ts
 * @description Clean, schema-validated runtime configuration for OWRadio.
 * Zero fake settings — only real operational parameters.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DEFAULT_GUILD_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),

  WEB_PORT: z.coerce.number().default(8091),
  WEB_HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().default(''),
  DATABASE_PATH: z.string().default('./data/owradio.sqlite'),

  YOUTUBE_POT_TOKEN: z.string().optional(),
  YOUTUBE_PROXY: z.string().optional(),
  YOUTUBE_COOKIES_PATH: z.string().optional(),

  AUTO_RESUME: z.coerce.boolean().default(true),
  DEFAULT_VOICE_CHANNEL_ID: z.string().optional(),
  DEFAULT_TEXT_CHANNEL_ID: z.string().optional(),
  AUTO_RESUME_DELAY_SEC: z.coerce.number().default(2),

  AUTH_ENABLED: z.coerce.boolean().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().default('owradio-studio-session-secret-v3'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ [Config] Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;

export const config = {
  ...raw,
  GUILD_ID: raw.DEFAULT_GUILD_ID || raw.DISCORD_GUILD_ID,
  isDiscordEnabled: Boolean(raw.DISCORD_TOKEN && raw.DISCORD_TOKEN.trim().length > 10),
};

export type Config = typeof config;
export default config;
