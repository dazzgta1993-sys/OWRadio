/**
 * @file index.ts
 * @description Main unified entrypoint for OWRadio.
 * Boots SQLite WAL Database, GuildPlayer Engine, Optional Discord Gateway Bot, and Hono Web Server in a single process.
 */

import config from './config.js';
import { sqlite } from './db/index.js';
import { GuildPlayer } from './player/GuildPlayer.js';
import { createDiscordBot } from './bot/client.js';
import { startWebServer } from './web/server.js';
import tasteRadar from './services/tasteRadar.js';
import type { Client } from 'discord.js';

console.log('====================================================');
console.log('⚡ OWRADIO - OPEN WEB RADIO & DISCORD AUDIO ENGINE');
console.log('====================================================');

async function main() {
  // 1. Initialize Player Engine
  console.log('[Bootstrap] Initializing Single-Server Player Engine...');
  const player = new GuildPlayer();

  // 2. Start Embedded Hono Web Server & VLC Radio Stream
  console.log('[Bootstrap] Starting Embedded Hono Web Server...');
  const server = startWebServer(player);

  // 3. Connect to Discord Gateway (Optional - Standalone Web Radio if token unset)
  let botClient: Client | null = null;
  if (config.DISCORD_TOKEN && config.DISCORD_TOKEN.trim().length > 0) {
    console.log('[Bootstrap] Connecting to Discord Gateway...');
    botClient = await createDiscordBot(player);
    try {
      await botClient.login(config.DISCORD_TOKEN);
      console.log('[Bootstrap] Discord login handshake successful.');
    } catch (err) {
      console.error('[Bootstrap] Failed to login to Discord:', (err as Error).message);
      console.warn('[Bootstrap] Web dashboard & /stream.mp3 continue running in standalone mode.');
    }
  } else {
    console.log('[Bootstrap] 📻 Operating in Standalone Web Radio Mode (DISCORD_TOKEN unset).');
    console.log(`[Bootstrap] Live MP3 Stream active at http://0.0.0.0:${config.WEB_PORT}/stream.mp3`);
    console.log(`[Bootstrap] Web Dashboard active at http://0.0.0.0:${config.WEB_PORT}/`);
  }

  // 4. Start Autonomous Taste Radar (Continuous Background Catalog Expansion & Turnover)
  tasteRadar.setActiveListenersProvider(() => player.getActiveListenerUserIds());
  tasteRadar.start();

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}. Gracefully stopping OWRadio...`);
    try {
      tasteRadar.stop();
      player.stop();
      player.disconnectVoice();
      player.broadcastTee.destroy();
      if (botClient) {
        botClient.destroy();
      }
      sqlite.close();
      console.log('[Shutdown] All subsystems terminated cleanly. Exiting.');
    } catch (err) {
      console.error('[Shutdown] Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Fatal] Unhandled startup exception:', err);
  process.exit(1);
});
