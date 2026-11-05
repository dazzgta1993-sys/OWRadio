/**
 * @file bot/autoResume.ts
 * @description Automatically connects the bot to the configured default Discord Voice Channel
 * on startup if AUTO_RESUME is enabled.
 */

import { Client, VoiceBasedChannel } from 'discord.js';
import { joinVoiceChannel, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';

export async function runAutoResume(client: Client): Promise<void> {
  if (!config.AUTO_RESUME) return;

  const delayMs = Math.max(1, config.AUTO_RESUME_DELAY_SEC) * 1000;
  await new Promise((r) => setTimeout(r, delayMs));

  try {
    const guildId = config.GUILD_ID || client.guilds.cache.first()?.id;
    if (!guildId) return;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    let targetChannel: VoiceBasedChannel | null = null;
    if (config.DEFAULT_VOICE_CHANNEL_ID) {
      const ch = await guild.channels.fetch(config.DEFAULT_VOICE_CHANNEL_ID).catch(() => null);
      if (ch && ch.isVoiceBased()) targetChannel = ch;
    }

    if (!targetChannel) {
      targetChannel =
        guild.channels.cache.find(
          (c): c is VoiceBasedChannel => c.isVoiceBased() && c.members.filter((m) => !m.user.bot).size > 0
        ) || null;
    }

    if (!targetChannel) return;

    const conn = joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: true,
    });

    globalPlayer.attachVoiceConnection(conn);
    console.log(`🔊 [AutoResume] Connected to Discord voice channel: ${targetChannel.name}`);
  } catch (err) {
    console.warn('⚠️ [AutoResume] Notice:', (err as Error).message);
  }
}
