/**
 * @file playerUi.ts
 * @description Minimal, sleek, and highly functional Discord Now Playing UI.
 * Features:
 * - Auto-updates on every song change, crossfade, and state transition.
 * - Always stays as the bottom-most (last sent) message in the playing channel.
 * - In-place editing when already at the bottom to prevent chat bounce/spam.
 * - Debounced repositioning when users send messages in the channel.
 * - Sleek, dark interactive controls (Play/Pause, Skip, Like, Vibe, Stop).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type TextBasedChannel,
  type Message,
  type VoiceBasedChannel,
  Events,
} from 'discord.js';
import type { GuildPlayer, PlayerStatePayload } from '../player/GuildPlayer.js';
import config from '../config.js';
import { getBotState, setBotState, sqlite } from '../db/index.js';
import featureFlags from '../services/featureFlags.js';
import stationCurator from '../services/stationCurator.js';
import dynamicSettings from '../services/dynamicSettings.js';

function formatDuration(sec: number): string {
  if (sec <= 0 || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function buildProgressBar(elapsedSec: number, durationSec: number, totalSegments = 14): string {
  if (durationSec <= 0 || isNaN(durationSec)) {
    return '─'.repeat(totalSegments);
  }
  const ratio = Math.max(0, Math.min(1, elapsedSec / durationSec));
  const pos = Math.round(ratio * totalSegments);
  const left = '━'.repeat(Math.max(0, pos));
  const right = '─'.repeat(Math.max(0, totalSegments - pos));
  return `${left}●${right}`;
}

export class PlayerUiService {
  private client: Client | null = null;
  private player: GuildPlayer | null = null;
  private boundChannelId: string | null = null;
  private currentMessageId: string | null = null;
  private isUpdating = false;
  private updateQueued = false;
  private messageDebounceTimer: NodeJS.Timeout | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
  private lastResendTimestamp = 0;

  public init(client: Client, player: GuildPlayer): void {
    this.client = client;
    this.player = player;

    // Restore last bound UI channel and active message from persistent storage
    this.boundChannelId = getBotState('last_ui_channel_id', '') || config.DEFAULT_TEXT_CHANNEL_ID || null;
    this.currentMessageId = getBotState('last_ui_message_id', '') || null;

    // Listen to player state changes (song start, finish, skip, pause, resume)
    this.player.on('stateChange', () => {
      this.scheduleUpdate(false);
    });

    // Listen to incoming messages in Discord to guarantee the UI is ALWAYS the last message
    this.client.on(Events.MessageCreate, (message: Message) => {
      this.handleIncomingMessage(message);
    });

    // Start a periodic progress ticker to keep progress bar and elapsed time fresh
    this.startProgressTicker();

    // Listen to dynamic settings changes for real-time reactivity
    dynamicSettings.on('change:discord_ui_update_interval_sec', () => {
      this.startProgressTicker();
    });
    dynamicSettings.on('change:discord_sticky_ui_enabled', (enabled: boolean) => {
      if (!enabled) {
        this.clearStickyMessage();
      } else {
        this.scheduleUpdate(true);
      }
    });

    console.log('[PlayerUi] ✨ Minimal Sleek Discord UI service initialized.');

    // Clean up any ghost messages left behind by prior bot sessions on startup
    setTimeout(() => {
      this.sweepAllGuildChannelsForGhostMessages().catch(() => {});
    }, 1500);
  }

  /**
   * Sets the channel where the UI should be rendered.
   * Persists to SQLite for seamless auto-resume across bot restarts.
   */
  public setBoundChannelId(channelId: string): void {
    if (this.boundChannelId !== channelId) {
      this.boundChannelId = channelId;
      setBotState('last_ui_channel_id', channelId);
      // Clean up previous message reference if channel switched
      this.currentMessageId = null;
    }
  }

  public getBoundChannelId(): string | null {
    return this.boundChannelId;
  }

  /**
   * Resolves the target text-based channel where the UI should be sent.
   * Priority: boundChannelId -> active voice channel (built-in text chat) -> last voice channel -> first available guild text channel.
   */
  private async resolveChannel(): Promise<TextBasedChannel | null> {
    if (!this.client) {
      console.warn('[PlayerUi] Cannot resolve channel: Discord client is null.');
      return null;
    }

    // 1. Try bound channel
    if (this.boundChannelId) {
      try {
        const ch = await this.client.channels.fetch(this.boundChannelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          return ch as TextBasedChannel;
        }
      } catch (e) {
        console.warn(`[PlayerUi] Bound channel ${this.boundChannelId} fetch error: ${(e as Error).message}`);
      }
    }

    // 2. Fall back to the active voice channel's text chat
    const voiceChannel = this.player?.getActiveVoiceChannel();
    if (voiceChannel) {
      try {
        if (voiceChannel.isTextBased()) {
          this.setBoundChannelId(voiceChannel.id);
          return voiceChannel as unknown as TextBasedChannel;
        }
      } catch (e) {
        console.warn(`[PlayerUi] Active voice channel text chat error: ${(e as Error).message}`);
      }
    }

    // 3. Fall back to stored voice channel
    const lastVoiceId = getBotState('last_voice_channel_id', '');
    if (lastVoiceId) {
      try {
        const ch = await this.client.channels.fetch(lastVoiceId).catch(() => null);
        if (ch && ch.isTextBased()) {
          this.setBoundChannelId(ch.id);
          return ch as TextBasedChannel;
        }
      } catch {}
    }

    // 4. Fall back to any text channel in primary guild
    const guild = this.client.guilds.cache.first();
    if (guild) {
      const textCh = guild.channels.cache.find(
        (c) => c.isTextBased() && (c.name.includes('music') || c.name.includes('bot') || c.name.includes('chat') || c.name.includes('general'))
      ) || guild.channels.cache.find((c) => c.isTextBased() && !c.isVoiceBased());

      if (textCh && textCh.isTextBased()) {
        this.setBoundChannelId(textCh.id);
        console.log(`[PlayerUi] Target channel resolved from guild text channel fallback: "${(textCh as any).name}" (${textCh.id})`);
        return textCh as TextBasedChannel;
      }
    }

    console.warn('[PlayerUi] Could not resolve any text-based channel for UI.');
    return null;
  }

  /**
   * Schedules an update with concurrency protection.
   * Edits the existing message in place whenever possible.
   */
  public scheduleUpdate(forceResend = false): void {
    if (forceResend) {
      this.repositionToBottom().catch(() => {});
      return;
    }
    if (this.isUpdating) {
      this.updateQueued = true;
      return;
    }

    this.updateUi(false).catch((err) => {
      console.warn('[PlayerUi] Error during UI update:', (err as Error).message);
    });
  }

  /**
   * Handles user chat messages in the bound channel.
   * Strictly filters out bots/webhooks to prevent infinite loops, debounces rapid typing,
   * and repositions the UI cleanly to the bottom.
   */
  private handleIncomingMessage(message: Message): void {
    // 1. CRITICAL: Strictly ignore all bots, webhooks, and our own client messages
    if (message.author.bot || message.webhookId || message.author.id === this.client?.user?.id) {
      return;
    }

    if (!dynamicSettings.getBoolean('discord_sticky_ui_enabled', true)) return;
    if (!this.player?.currentTrack) return;

    // 2. Only handle messages in the active bound UI channel
    if (!this.boundChannelId || message.channelId !== this.boundChannelId) {
      return;
    }

    // 3. Ignore our own UI message
    if (message.id === this.currentMessageId) return;

    // 4. Debounce: if a user types multiple messages, reset timer
    // so we only perform ONE reposition after they pause typing.
    const debounceMs = dynamicSettings.getNumber('discord_ui_debounce_ms', 1200);
    if (this.messageDebounceTimer) {
      clearTimeout(this.messageDebounceTimer);
    }
    this.messageDebounceTimer = setTimeout(() => {
      this.messageDebounceTimer = null;
      this.repositionToBottom();
    }, debounceMs);
  }

  /**
   * Repositions the UI message to the very bottom of the channel.
   * Only deletes/re-sends if the message is NOT already the latest message in the channel.
   * Includes a cooldown guard to prevent rapid delete/re-sends.
   */
  public async repositionToBottom(): Promise<void> {
    if (!this.player?.currentTrack || !this.client) return;

    const channel = await this.resolveChannel();
    if (!channel) return;

    // Check if our message is ALREADY the latest message in the channel
    if (this.currentMessageId) {
      try {
        const recent = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const latest = recent?.first();
        if (latest && latest.id === this.currentMessageId) {
          // Already at the bottom! Just edit in place.
          await this.updateUi(false);
          return;
        }
      } catch {}
    }

    // Rate-limit guard: Never delete & resend faster than once every 2 seconds
    const now = Date.now();
    if (now - this.lastResendTimestamp < 2000) {
      if (!this.messageDebounceTimer) {
        this.messageDebounceTimer = setTimeout(() => {
          this.messageDebounceTimer = null;
          this.repositionToBottom();
        }, 2000);
      }
      return;
    }

    await this.updateUi(true);
  }

  /**
   * Main render method.
   * If already at the bottom of the channel, edits the message in place.
   * If other messages have been posted below it (or forceResend is true), posts at bottom and deletes old message.
   */
  public async updateUi(forceResend = false): Promise<void> {
    if (!this.player || !this.client) return;
    if (this.isUpdating) {
      this.updateQueued = true;
      return;
    }
    this.isUpdating = true;

    try {
      const channel = await this.resolveChannel();
      if (!channel) {
        console.warn('[PlayerUi] Skipping updateUi: No channel resolved.');
        return;
      }

      const state = this.player.getStatePayload();
      const track = state.track;

      // Check if sticky UI is disabled via dynamic settings
      if (!dynamicSettings.getBoolean('discord_sticky_ui_enabled', true)) {
        await this.clearStickyMessage();
        return;
      }

      // Case 1: Player is idle / stopped
      if (!track || !this.player.currentTrack) {
        await this.clearStickyMessage();
        return;
      }

      // Case 2: Active playback -> Build minimal sleek embed & buttons
      const { embed, components } = this.buildUiPayload(state);

      // Check if our message is already the last message in the channel
      let isAlreadyLast = false;
      if (this.currentMessageId) {
        try {
          const recent = await channel.messages.fetch({ limit: 1 }).catch(() => null);
          const latest = recent?.first();
          if (latest && latest.id === this.currentMessageId) {
            isAlreadyLast = true;
          }
        } catch {}
      }

      // If it is already the last message (and forceResend is not explicitly requested),
      // or if forceResend was requested BUT no other message was sent below it:
      // EDIT IN PLACE (zero delete, zero resend, zero flicker, zero scroll bounce!)
      if (isAlreadyLast && this.currentMessageId) {
        try {
          const msg = await channel.messages.fetch(this.currentMessageId).catch(() => null);
          if (msg) {
            await msg.edit({ embeds: [embed], components });
            return;
          }
        } catch {
          // If edit fails (e.g. message was manually deleted by someone), fall through to send fresh
        }
      }

      // It is NOT the last message (someone chatted below it, or command was run)
      // Send the fresh message at the bottom FIRST
      const oldId = this.currentMessageId;
      const newMsg = await (channel as any).send({ embeds: [embed], components });
      this.currentMessageId = newMsg.id;
      setBotState('last_ui_message_id', newMsg.id);
      this.lastResendTimestamp = Date.now();
      console.log(`[PlayerUi] 🎵 Now Playing UI rendered at channel bottom (msgId: ${newMsg.id}, channel: ${(channel as any).name || channel.id})`);

      // CRITICAL: Clean up ALL older messages sent by this bot to guarantee strictly 1 living message
      this.purgeOldBotMessages(channel, newMsg.id).catch(() => {});
    } catch (err) {
      console.warn('[PlayerUi] Failed to render UI message:', (err as Error).message);
    } finally {
      this.isUpdating = false;
      if (this.updateQueued) {
        this.updateQueued = false;
        setTimeout(() => this.scheduleUpdate(), 300);
      }
    }
  }

  /**
   * Purges all older messages sent by this bot in the target channel to guarantee
   * strictly ONE living Now Playing widget exists (self-cleaning guarantee).
   */
  
  /**
   * Sweeps all cached text channels across connected guilds to purge dangling Now Playing widgets
   * from previous sessions, guaranteeing strictly ONE active bot message exists server-wide.
   */
  public async sweepAllGuildChannelsForGhostMessages(): Promise<void> {
    try {
      if (!this.client?.user) return;
      for (const [_, guild] of this.client.guilds.cache) {
        for (const [_, ch] of guild.channels.cache) {
          if (ch.isTextBased()) {
            await this.purgeOldBotMessages(ch as TextBasedChannel, this.currentMessageId || undefined).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn('[PlayerUi] Ghost message sweep warning:', (err as Error).message);
    }
  }

  public async purgeOldBotMessages(channel: TextBasedChannel, keepMsgId?: string): Promise<void> {
    try {
      if (!this.client?.user) return;
      const botUserId = this.client.user.id;
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) return;

      const toDelete = messages.filter((m) => {
        if (m.id === keepMsgId) return false;
        if (m.author.id === botUserId) return true;
        if (m.author.bot && m.embeds && m.embeds.some((e) => {
          const banner = `${e.title || ''} ${e.author?.name || ''}`.toUpperCase();
          return banner.includes('NOW PLAYING') || banner.includes('NOW BROADCASTING') || banner.includes('HI-FI STREAM');
        })) {
          return true;
        }
        return false;
      });

      if (toDelete.size === 0) return;

      // Fast bulkDelete for messages under 14 days old (zero rate-limit, 1 network roundtrip)
      if ('bulkDelete' in channel && typeof (channel as any).bulkDelete === 'function') {
        const bulkEligible = toDelete.filter((m) => Date.now() - m.createdTimestamp < 14 * 24 * 3600 * 1000);
        if (bulkEligible.size > 0) {
          await (channel as any).bulkDelete(bulkEligible, true).catch(() => {});
        }
        const older = toDelete.filter((m) => Date.now() - m.createdTimestamp >= 14 * 24 * 3600 * 1000);
        for (const [_id, msg] of older) {
          await msg.delete().catch(() => {});
        }
      } else {
        for (const [_id, msg] of toDelete) {
          await msg.delete().catch(() => {});
        }
      }

      console.log(`[PlayerUi] 🧹 Cleaned up ${toDelete.size} old bot message(s) in channel ${(channel as any).name || channel.id}.`);
    } catch (err) {
      console.warn('[PlayerUi] Error during bot message cleanup:', (err as Error).message);
    }
  }

  /**
   * Generates the ultra-compact Discord Now Playing micro-card and single-row controls (<100px total height).
   */
  private buildUiPayload(state: PlayerStatePayload): {
    embed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const track = state.track!;
    const isPaused = this.player?.isPaused ?? false;

    // Dynamic theme color
    let themeColor = 0x6366f1; // Indigo / Studio Violet
    if (state.radioStation) {
      themeColor = 0x38bdf8; // Sky Blue
    } else if (state.timeCapsuleYear) {
      themeColor = 0xf59e0b; // Gold
    } else if (state.morph?.active) {
      themeColor = 0xec4899; // Magenta
    } else if (track.curatedBy === 'AI Vibe Mix') {
      themeColor = 0xa855f7; // Purple
    } else if (track.curatedBy === 'User Request' || track.isManualRequest) {
      themeColor = track.requestType === 'playlist' ? 0x3b82f6 : 0x10b981;
    }

    const elapsed = track.elapsedSec || 0;
    const duration = track.durationSec || 0;
    const bar = buildProgressBar(elapsed, duration, 14);

    // Format up next
    let upNextTag = '';
    if (state.upNext) {
      if (state.upNext.requestType === 'single') {
        upNextTag = ' `⭐ VIP`';
      } else if (state.upNext.requestType === 'playlist') {
        upNextTag = ' `📋 Blend`';
      }
    }

    const upNextText = state.upNext
      ? `**${state.upNext.title}** — *${state.upNext.artist}*${upNextTag}`
      : '*(Dynamic Consensus)*';

    const yearStr = track.releaseYear ? ` (${track.releaseYear})` : '';
    const albumStr = track.album ? ` • 💿 *${track.album}${yearStr}*` : (yearStr ? ` • 📅 *${yearStr}*` : '');

    const webBaseUrl = config.PUBLIC_URL || (state.streamUrl && !state.streamUrl.includes('127.0.0.1') ? state.streamUrl.replace('/stream.mp3', '') : (state.streamUrl ? state.streamUrl.replace('/stream.mp3', '') : `http://127.0.0.1:${config.WEB_PORT}`));
    const cleanWebUrl = webBaseUrl.replace(/\/+$/, '');

    // Ultra-Compact 3-Line Micro-Card (<100px)
    const embed = new EmbedBuilder()
      .setColor(themeColor)
      .setTitle(`🎵 ${track.title} — ${track.artist}`)
      .setURL(cleanWebUrl.startsWith('http') ? cleanWebUrl : `https://${cleanWebUrl}`)
      .setDescription(
        `${albumStr ? `${albumStr.replace(/^\s*•\s*/, '')}\n` : ''}` +
        `▶ \`${formatDuration(elapsed)}\`  ${bar}  \`${formatDuration(duration)}\`\n` +
        `⏭️ *Up Next:* ${upNextText}`
      );

    if (track.artworkUrl) {
      embed.setThumbnail(track.artworkUrl);
    }

    // Single-Row of exactly 4 controls (Zero wrapping on mobile & desktop)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_ui_replay')
        .setEmoji('⏮️')
        .setLabel('Replay')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_ui_play_pause')
        .setEmoji(isPaused ? '▶️' : '⏸️')
        .setLabel(isPaused ? 'Resume' : 'Pause')
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_ui_skip')
        .setEmoji('⏭️')
        .setLabel('Skip')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_ui_more')
        .setEmoji('⚙️')
        .setLabel('More...')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embed, components: [row] };
  }

  /**
   * Cleans up the existing sticky UI message from the Discord channel.
   */
  public async clearStickyMessage(): Promise<void> {
    if (!this.currentMessageId) return;
    const oldId = this.currentMessageId;
    this.currentMessageId = null;
    const channel = await this.resolveChannel();
    if (channel) {
      try {
        const oldMsg = await channel.messages.fetch(oldId).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
        console.log('[PlayerUi] Cleaned up Now Playing message.');
      } catch {}
    }
  }

  /**
   * Periodic ticker to smoothly update elapsed time on the progress bar.
   * Dynamic update interval configurable via settings (5s to 60s).
   */
  public startProgressTicker(): void {
    if (this.progressInterval) clearInterval(this.progressInterval);
    const intervalSec = dynamicSettings.getNumber('discord_ui_update_interval_sec', 15);
    this.progressInterval = setInterval(() => {
      if (this.player?.currentTrack && !this.player.isPaused) {
        this.scheduleUpdate(false);
      }
    }, intervalSec * 1000);
  }

  /**
   * Cleans up resources on shutdown.
   */
  public destroy(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.messageDebounceTimer) {
      clearTimeout(this.messageDebounceTimer);
      this.messageDebounceTimer = null;
    }
  }
}

export const playerUi = new PlayerUiService();
export default playerUi;
