/**
 * @file bot/autoResume.ts
 * @description Restores recent playback history, connects to the default Discord Voice Channel,
 * and automatically starts 24/7 Autoplay broadcasting on startup.
 */

import { Client, VoiceBasedChannel } from 'discord.js';
import { joinVoiceChannel, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';
import AudioTrack from '../player/AudioTrack.js';
import { getRecentHistory } from '../db/store.js';
import { extractPrimaryArtist } from '../utils/artistNormalizer.js';

export async function runAutoResume(client: Client): Promise<void> {
  if (!config.AUTO_RESUME) return;

  // 1. Restore recent playback history & Vibe Anchor from SQLite
  try {
    const rows = getRecentHistory(15, 'global');
    if (rows.length > 0 && globalPlayer.history.length === 0) {
      for (const r of [...rows].reverse()) {
        globalPlayer.history.push(
          new AudioTrack({
            id: String(r.track_id || ''),
            videoId: String(r.video_id || ''),
            title: String(r.title || ''),
            artist: String(r.artist || ''),
            album: String(r.album || ''),
            duration: Number(r.duration_sec || 0),
            artworkUrl: String(r.artwork_url || ''),
            source: (r.source as any) || 'ytmusic',
            isAutoplay: Boolean(r.is_autoplay),
            requestedBy: String(r.requested_by || 'AutoResume'),
          })
        );
      }
      if (!globalPlayer.vibeAnchorArtist && rows[0]?.artist) {
        globalPlayer.vibeAnchorArtist = extractPrimaryArtist(String(rows[0].artist));
      }
    }
  } catch {}

  const delayMs = Math.max(1, config.AUTO_RESUME_DELAY_SEC) * 1000;
  await new Promise((r) => setTimeout(r, delayMs));

  // 2. Connect to Discord Voice Channel if available
  try {
    const guildId = config.GUILD_ID || client.guilds.cache.first()?.id;
    if (guildId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (guild) {
        let targetChannel: VoiceBasedChannel | null = null;
        if (config.DEFAULT_VOICE_CHANNEL_ID) {
          const ch = await guild.channels.fetch(config.DEFAULT_VOICE_CHANNEL_ID).catch(() => null);
          if (ch && ch.isVoiceBased()) targetChannel = ch;
        }
        if (!targetChannel) {
          targetChannel =
            guild.channels.cache.find(
              (c): c is VoiceBasedChannel =>
                c.isVoiceBased() && c.members.filter((m) => !m.user.bot).size > 0
            ) ||
            guild.channels.cache.find((c): c is VoiceBasedChannel => c.isVoiceBased()) ||
            null;
        }
        if (targetChannel) {
          const conn = joinVoiceChannel({
            channelId: targetChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
            selfDeaf: true,
          });
          globalPlayer.attachVoiceConnection(conn);
          console.log(`🔊 [AutoResume] Connected to Discord voice channel: ${targetChannel.name}`);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ [AutoResume] Voice connection notice:', (err as Error).message);
  }

  // 3. Automatically start 24/7 radio playback if currently idle
  if (!globalPlayer.isPlaying && globalPlayer.autoplay) {
    console.log('📻 [AutoResume] Starting automatic 24/7 radio broadcast...');
    void globalPlayer.playNext();
  }
}
