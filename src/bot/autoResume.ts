/**
 * @file bot/autoResume.ts
 * @description Restores recent playback history, locks the Anchor to the last manually
 * requested song (never an Autoplay drift track), connects to Discord Voice, and starts 24/7 radio.
 */

import { Client, VoiceBasedChannel } from 'discord.js';
import { joinVoiceChannel, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';
import AudioTrack from '../player/AudioTrack.js';
import { getRecentHistory, getTasteProfile } from '../db/store.js';
import { extractPrimaryArtist } from '../utils/artistNormalizer.js';

export async function runAutoResume(client: Client): Promise<void> {
  if (!config.AUTO_RESUME) return;

  // 1. Restore recent playback history & lock Vibe Anchor to the last MANUAL track
  try {
    const rows = getRecentHistory(50, 'global');
    if (rows.length > 0 && globalPlayer.history.length === 0) {
      let lastManualTrack: AudioTrack | null = null;
      for (const r of [...rows].reverse()) {
        const trk = new AudioTrack({
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
        });
        globalPlayer.history.push(trk);
        if (!trk.isAutoplay) {
          lastManualTrack = trk;
        }
      }
      const taste = getTasteProfile('global');
      const lovedList = Array.from(taste.likedArtists);
      const anchorSource = lastManualTrack || globalPlayer.history[globalPlayer.history.length - 1];
      if (!globalPlayer.vibeAnchorArtist) {
        if (lovedList.length > 0) {
          const loved = lovedList[lovedList.length - 1];
          globalPlayer.vibeAnchorArtist = loved;
          if (anchorSource && extractPrimaryArtist(anchorSource.artist).toLowerCase() === loved.toLowerCase()) {
            globalPlayer.vibeAnchorTrack = anchorSource;
          } else {
            globalPlayer.vibeAnchorTrack = null;
          }
          console.log(`⚓ [AutoResume] Restored Vibe Anchor from Loved Vibes: ${globalPlayer.vibeAnchorArtist}`);
        } else if (anchorSource) {
          globalPlayer.vibeAnchorArtist = extractPrimaryArtist(anchorSource.artist);
          globalPlayer.vibeAnchorTrack = anchorSource;
          console.log(`⚓ [AutoResume] Restored Vibe Anchor: ${globalPlayer.vibeAnchorArtist} — ${anchorSource.title}`);
        }
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
