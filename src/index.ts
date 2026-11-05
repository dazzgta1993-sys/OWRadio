/**
 * @file index.ts
 * @description Clean entry point for OWRadio v3.0 (100% Real Studio Audio Engine).
 */

import { startWebServer } from './web/server.js';
import { startDiscordBot } from './bot/client.js';

async function main(): Promise<void> {
  console.log('🚀 [OWRadio] Starting 100% Real Studio Audio Engine...');
  startWebServer();
  await startDiscordBot();
}

main().catch((err) => {
  console.error('❌ [OWRadio] Fatal startup error:', err);
  process.exit(1);
});
