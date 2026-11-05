/**
 * @file autoResume.ts
 * @description Intelligent Auto-Resume Subsystem for VEXO.
 * Automatically restores Discord voice channel connection and resumes autonomous playback
 * when the bot restarts or recovers from crashes/reboots, without requiring /play commands.
 */

import { type Client, type VoiceBasedChannel, type Guild, Collection } from 'discord.js';
import config from '../config.js';
import { getBotState } from '../db/index.js';
import dynamicSettings from '../services/dynamicSettings.js';
import type { GuildPlayer } from '../player/GuildPlayer.js';
import playerUi from './playerUi.js';

export interface AutoResumeResult {
  resumed: boolean;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  activeListenersCount: number;
  reason: string;
}

/**
 * Discovers the best voice channel candidate to resume playback in.
 */
export async function resolveAutoResumeChannel(
  client: Client
): Promise<{ guild: Guild; channel: VoiceBasedChannel; isPopulated: boolean } | null> {
  const savedGuildId = getBotState('last_guild_id') || config.DEFAULT_GUILD_ID;
  const primaryGuild = (savedGuildId ? client.guilds.cache.get(savedGuildId) : null) || client.guilds.cache.first();

  if (!primaryGuild) {
    console.warn('[AutoResume] No cached guilds available for auto-resume.');
    return null;
  }

  // Fetch all voice channels for this guild
  const channels = await primaryGuild.channels.fetch().catch(() => null);
  if (!channels) {
    console.warn(`[AutoResume] Failed to fetch channels for guild "${primaryGuild.name}".`);
    return null;
  }

  const voiceChannels: VoiceBasedChannel[] = [];
  for (const [, ch] of channels) {
    if (ch && ch.isVoiceBased()) {
      voiceChannels.push(ch as VoiceBasedChannel);
    }
  }

  if (voiceChannels.length === 0) {
    console.warn(`[AutoResume] Guild "${primaryGuild.name}" has no voice channels.`);
    return null;
  }

  // 1. Check if any voice channel currently has active human listeners
  let bestPopulatedChannel: VoiceBasedChannel | null = null;
  let maxListeners = 0;

  for (const channel of voiceChannels) {
    const nonBots = channel.members.filter((m) => !m.user.bot);
    if (nonBots.size > maxListeners) {
      maxListeners = nonBots.size;
      bestPopulatedChannel = channel;
    }
  }

  // 2. Check saved channel or pinned voice channel override from settings
  const pinnedChannelId = dynamicSettings.getString('discord_pinned_voice_channel_id', '');
  const savedChannelId = pinnedChannelId || getBotState('last_voice_channel_id') || config.DEFAULT_VOICE_CHANNEL_ID;
  let savedChannel: VoiceBasedChannel | null = null;
  if (savedChannelId) {
    savedChannel = voiceChannels.find((c) => c.id === savedChannelId) || null;
  }

  // Decision Logic:
  // If a populated channel has humans, prioritize where listeners are gathered!
  if (bestPopulatedChannel && maxListeners > 0) {
    return {
      guild: primaryGuild,
      channel: bestPopulatedChannel,
      isPopulated: true,
    };
  }

  // If saved channel exists, resume in that channel (even if currently empty, so radio is ready)
  if (savedChannel) {
    return {
      guild: primaryGuild,
      channel: savedChannel,
      isPopulated: false,
    };
  }

  // Fallback to first available voice channel
  const fallback = voiceChannels[0] || null;
  if (fallback) {
    return {
      guild: primaryGuild,
      channel: fallback,
      isPopulated: false,
    };
  }

  return null;
}

/**
 * Initiates the auto-resume sequence after the Discord gateway is ready.
 */
export async function executeAutoResume(
  client: Client,
  player: GuildPlayer
): Promise<AutoResumeResult> {
  if (!config.AUTO_RESUME) {
    console.log('[AutoResume] Auto-resume is disabled in configuration (AUTO_RESUME=false).');
    return { resumed: false, activeListenersCount: 0, reason: 'Disabled via config' };
  }

  // Wait grace period for Discord WebSocket and guild member caches to hydrate
  const delaySec = config.AUTO_RESUME_DELAY_SEC;
  if (delaySec > 0) {
    console.log(`[AutoResume] Waiting ${delaySec}s for Discord voice caches to settle...`);
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }

  const target = await resolveAutoResumeChannel(client);
  if (!target) {
    console.warn('[AutoResume] Could not resolve a voice channel candidate.');
    return { resumed: false, activeListenersCount: 0, reason: 'No voice channel candidate found' };
  }

  const { guild, channel } = target;
  const listenerCount = channel.members.filter((m) => !m.user.bot).size;

  console.log(
    `[AutoResume] Target acquired: "${channel.name}" (${channel.id}) in "${guild.name}" with ${listenerCount} active listeners.`
  );

  try {
    // 1. Connect to Discord voice channel
    await player.connectToVoice(channel);
    console.log(`[AutoResume] Voice connection established in "${channel.name}".`);

    // 2. Resume or replenish playback
    const wasAlreadyPlaying = Boolean(player.currentTrack);
    if (!wasAlreadyPlaying) {
      console.log('[AutoResume] Starting playback via autoResumePlayback()...');
      await player.autoResumePlayback();
    }

    const currentTrackName = player.currentTrack
      ? `${player.currentTrack.artist} - ${player.currentTrack.title}`
      : 'Autoplay queue initialized';

    console.log(`[AutoResume] 🚀 Playback active in Discord voice channel: "${currentTrackName}"`);

    // 3. Render Sleek Minimal UI at the bottom of the voice channel
    if (channel.isTextBased()) {
      playerUi.setBoundChannelId(channel.id);
      playerUi.scheduleUpdate();
    }

    // 3. Log to Brain Telemetry
    
    return {
      resumed: true,
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name,
      activeListenersCount: listenerCount,
      reason: 'Success',
    };
  } catch (err) {
    console.error('[AutoResume] Execution failed:', (err as Error).message);
    return {
      resumed: false,
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name,
      activeListenersCount: listenerCount,
      reason: (err as Error).message,
    };
  }
}

export default {
  resolveAutoResumeChannel,
  executeAutoResume,
};
