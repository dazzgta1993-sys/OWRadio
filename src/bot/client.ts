/**
 * @file client.ts
 * @description Discord Client initialization, guild-scoped slash command registration,
 * command routing, and voice room membership state listeners.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Interaction,
  type VoiceState,
} from 'discord.js';
import config from '../config.js';
import { sqlite } from '../db/index.js';
import featureFlags from '../services/featureFlags.js';
import deezer from '../services/deezer.js';
import dynamicSettings from '../services/dynamicSettings.js';
import type { GuildPlayer } from '../player/GuildPlayer.js';
import { executeAutoResume } from './autoResume.js';
import playerUi from './playerUi.js';
import {
  playCommand,
  vibeCommand,
  handlePlay,
  handleVibe,
} from './commands/play.js';
import {
  controlCommand,
  skipCommand,
  pauseCommand,
  resumeCommand,
  stopCommand,
  clearCommand,
  removeCommand,
  shuffleCommand,
  replayCommand,
  statusCommand,
  historyCommand,
  volumeCommand,
  likeCommand,
  dislikeCommand,
  queueCommand,
  joinCommand,
  leaveCommand,
  handleSkip,
  handlePause,
  handleResume,
  handleStop,
  handleClear,
  handleRemove,
  handleShuffle,
  handleReplay,
  handleStatus,
  handleHistory,
  handleVolume,
  handleLike,
  handleDislike,
  handleQueue,
  handleJoin,
  handleLeave,
} from './commands/controls.js';

import {
  stationCommand,
  artistCommand,
  tasteCommand,
  throwbackCommand,
  radioCommand,
  morphCommand,
  vetoCommand,
  handleArtist,
  handleTaste,
  handleThrowback,
  handleRadio,
  handleMorph,
  handleVeto,
} from './commands/features.js';
import {
  filterCommand,
  handleFilterCommand,
  handleFilterButtonInteraction,
} from './commands/filter.js';

// --- Consolidated Slash Commands List (Option C: 7 Master Commands) ---
const ALL_COMMANDS = [
  playCommand,     // /play <query>
  vibeCommand,     // /vibe <prompt>
  controlCommand,  // /control <skip|pause|resume|replay|queue|clear|shuffle|remove|volume|status|history|like|dislike>
  stationCommand,  // /station <preset|throwback|morph|filter|artist>
  tasteCommand,    // /taste <profile|playlist|artists|genres|clear|veto>
  joinCommand,     // /join
  leaveCommand,    // /leave
];

export async function createDiscordBot(player: GuildPlayer): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });

  player.setDiscordClient(client);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[DiscordBot] Logged in as ${readyClient.user.tag}`);

    // Initialize Minimal Sleek Auto-Updating Discord UI
    playerUi.init(readyClient, player);

    // 1. Trigger intelligent auto-resume on startup immediately (no /play command required)
    executeAutoResume(readyClient, player).catch((err) => {
      console.error('[DiscordBot] Auto-resume background task failed:', (err as Error).message);
    });

    // 2. Resolve primary guild: DEFAULT_GUILD_ID or first cached guild
    const guild = config.DEFAULT_GUILD_ID
      ? readyClient.guilds.cache.get(config.DEFAULT_GUILD_ID)
      : readyClient.guilds.cache.first();

    if (guild) {
      console.log(`[DiscordBot] Primary guild selected: "${guild.name}" (${guild.id})`);
      try {
        // Register slash commands directly to primary guild for 0-second propagation
        await guild.commands.set(ALL_COMMANDS.map((c) => c.toJSON()));
        console.log(`[DiscordBot] Successfully registered ${ALL_COMMANDS.length} slash commands to guild "${guild.name}"`);

        // Cache known guild members into users table non-blocking
        const members = guild.members.cache;
        const nowTs = Math.floor(Date.now() / 1000);
        const upsertUserStmt = sqlite.prepare(`
          INSERT OR REPLACE INTO users (id, username, display_name, avatar_url, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const [id, member] of members) {
          if (member.user.bot) continue;
          upsertUserStmt.run(
            id,
            member.user.username,
            member.displayName || member.user.globalName || member.user.username,
            member.user.displayAvatarURL() || null,
            nowTs
          );
        }
        console.log(`[DiscordBot] Synchronized ${members.size} cached guild members into users directory.`);
      } catch (err) {
        console.error('[DiscordBot] Guild setup error:', (err as Error).message);
      }
    } else {
      console.warn('[DiscordBot] No guild found in cache. Commands could not be registered to a primary guild.');
    }
  });

  // Handle Slash Command and Button Interactions
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Keep user identity fresh in users table
    if (interaction.user) {
      try {
        sqlite.prepare(`
          INSERT OR REPLACE INTO users (id, username, display_name, avatar_url, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          interaction.user.id,
          interaction.user.username,
          (interaction.member as any)?.displayName || interaction.user.globalName || interaction.user.username,
          interaction.user.displayAvatarURL() || null,
          Math.floor(Date.now() / 1000)
        );
      } catch {}
    }

    // Handle Autocomplete for /play
    if (interaction.isAutocomplete() && interaction.commandName === 'play') {
      try {
        const focused = interaction.options.getFocused();
        if (!focused || focused.trim().length === 0) {
          await interaction.respond([]);
          return;
        }
        if (focused.startsWith('http://') || focused.startsWith('https://')) {
          await interaction.respond([{ name: `🔗 Link: ${focused}`.slice(0, 100), value: focused.slice(0, 100) }]);
          return;
        }
        const results = await deezer.searchTracks(focused, 5);
        await interaction.respond(
          results.map((t) => ({
            name: `🎵 ${t.title} - ${t.artist}`.slice(0, 100),
            value: `${t.artist} - ${t.title}`.slice(0, 100),
          }))
        );
      } catch {
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // Handle StringSelectMenu for /remove
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_ui_remove_track') {
        const idx = parseInt(interaction.values[0], 10);
        if (isNaN(idx)) {
          await interaction.reply({ content: '❌ Invalid track selected.', ephemeral: true });
          return;
        }
        const removed = player.removeTrackAt(idx);
        if (removed) {
          await interaction.reply({
            content: `🗑️ Removed **${removed.title}** by **${removed.artist}** from queue.`,
            ephemeral: true,
          });
          playerUi.scheduleUpdate(false);
        } else {
          await interaction.reply({ content: '⚠️ Could not find track in queue.', ephemeral: true });
        }
        return;
      }
    }

    // Handle Button Interactions
    if (interaction.isButton()) {
      try {
        const customId = interaction.customId;

      // --- Minimal Sleek Player UI Controls ---
      if (customId === 'btn_ui_play_pause') {
        if (!player.currentTrack) {
          await interaction.reply({ content: '🔇 Nothing is currently playing.', ephemeral: true });
          return;
        }
        if (player.isPaused) {
          player.resume();
        } else {
          player.pause();
        }
        await interaction.deferUpdate().catch(() => {});
        playerUi.scheduleUpdate(false);
        return;
      }

      if (customId === 'btn_ui_skip') {
        if (!player.currentTrack) {
          await interaction.reply({ content: '🔇 Nothing is currently playing.', ephemeral: true });
          return;
        }
        player.skip(interaction.user.id);
        await interaction.deferUpdate().catch(() => {});
        playerUi.scheduleUpdate(false);
        return;
      }

      if (customId === 'btn_ui_replay') {
        await handleReplay(interaction as any, player);
        playerUi.scheduleUpdate(false);
        return;
      }

      if (customId === 'btn_ui_shuffle') {
        await handleShuffle(interaction as any, player);
        playerUi.scheduleUpdate(false);
        return;
      }

      if (customId === 'btn_ui_like') {
        await handleLike(interaction as any, player);
        return;
      }

      if (customId === 'btn_ui_dislike') {
        await handleDislike(interaction as any, player);
        return;
      }

      if (customId === 'btn_ui_vibe') {
        // Preserve immediately primed Deck B so audio streaming is completely uninterrupted
        player.recurateAutoplayBuffer(true).catch((err) => {
          console.warn('[DiscordBot] Vibe recurate error:', (err as Error).message);
        });
        await interaction.reply({ content: '✨ Recurated upcoming queue to match active room vibe!', ephemeral: true });
        playerUi.scheduleUpdate();
        return;
      }

      if (customId === 'btn_ui_queue') {
        await handleQueue(interaction as any, player);
        return;
      }

      if (customId === 'btn_ui_more') {
        const state = player.getStatePayload();
        const liveSetting = dynamicSettings.getString('curation_filter_live', 'none');
        const coverSetting = dynamicSettings.getString('curation_filter_covers', 'none');
        const rerecordSetting = dynamicSettings.getString('curation_filter_rerecorded', 'none');
        const liveBadge = liveSetting === 'none' ? '🚫 No Lives' : (liveSetting === 'high_quality' ? '⭐ HQ Lives' : '📻 Any Live');
        const coverBadge = coverSetting === 'none' ? '🚫 No Covers' : (coverSetting === 'high_quality' ? '⭐ HQ Covers' : '📻 Any Cover');
        const rerecordBadge = rerecordSetting === 'none' ? '🚫 Original Masters' : '📻 Any Cut';

        const webBaseUrl = config.PUBLIC_URL || (state.streamUrl && !state.streamUrl.includes('127.0.0.1') ? state.streamUrl.replace('/stream.mp3', '') : (state.streamUrl ? state.streamUrl.replace('/stream.mp3', '') : `http://127.0.0.1:${config.WEB_PORT}`));
        const cleanWebUrl = webBaseUrl.replace(/\/+$/, '');

        const moreEmbed = new EmbedBuilder()
          .setColor(0x6366f1)
          .setTitle('⚙️ Station Controls & Listener Suite')
          .setDescription(
            `🔊 **Volume:** \`${state.volume}%\`  •  📋 **Queue Depth:** \`${state.queueLength} tracks\`\n` +
            `🎛️ **Active Studio Guard:** \`${liveBadge}\`  •  \`${coverBadge}\`  •  \`${rerecordBadge}\`\n` +
            (state.track ? `🎵 **Now Playing:** *${state.track.title}* — **${state.track.artist}**` : '🔇 *Idle*')
          );

        // Row 1: Taste Actions
        const r1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_ui_like')
            .setEmoji('❤️')
            .setLabel('Like Song')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('btn_ui_dislike')
            .setEmoji('💔')
            .setLabel('Dislike Song')
            .setStyle(ButtonStyle.Secondary)
        );

        // Row 2: Queue & Curation
        const r2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_ui_vibe')
            .setEmoji('✨')
            .setLabel('AI Vibe')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('btn_ui_shuffle')
            .setEmoji('🔀')
            .setLabel('Shuffle')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('btn_ui_queue')
            .setEmoji('📋')
            .setLabel('Queue')
            .setStyle(ButtonStyle.Secondary)
        );

        // Row 3: Studio Guard Filter, Web Studio & Close
        const r3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_ui_filter')
            .setEmoji('🎛️')
            .setLabel('Studio Guard')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setLabel('Web Studio')
            .setEmoji('🌐')
            .setStyle(ButtonStyle.Link)
            .setURL(cleanWebUrl.startsWith('http') ? cleanWebUrl : `https://${cleanWebUrl}`),
          new ButtonBuilder()
            .setCustomId('btn_ui_close_ephemeral')
            .setEmoji('❌')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          embeds: [moreEmbed],
          components: [r1, r2, r3],
          ephemeral: true,
        });
        return;
      }

      if (customId === 'btn_ui_close_ephemeral') {
        try {
          if ('deleteReply' in interaction && typeof (interaction as any).deleteReply === 'function') {
            await (interaction as any).deleteReply();
          } else {
            await (interaction as any).deferUpdate().catch(() => {});
          }
        } catch {}
        return;
      }

      if (customId === 'btn_vibe_steer_off') {
                await player.recurateAutoplayBuffer();
        await interaction.reply({
          content: '✨ **384-d Latent Vibe Steering Disengaged.** Autoplay buffer purged and restored to natural room listener consensus.',
          ephemeral: true,
        });
        return;
      }
    } catch (btnErr) {
      console.error('[DiscordBot] Button interaction error:', (btnErr as Error).message);
    }
  }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.channelId) {
      playerUi.setBoundChannelId(interaction.channelId);
    }

    try {
      switch (interaction.commandName) {
        case 'play':
          await handlePlay(interaction, player);
          break;
        case 'vibe':
          await handleVibe(interaction, player);
          break;
        case 'control': {
          const sub = interaction.options.getSubcommand();
          switch (sub) {
            case 'skip':
              await handleSkip(interaction, player);
              break;
            case 'pause':
              await handlePause(interaction, player);
              break;
            case 'resume':
              await handleResume(interaction, player);
              break;
            case 'replay':
              await handleReplay(interaction, player);
              break;
            case 'queue':
              await handleQueue(interaction, player);
              break;
            case 'clear':
              await handleClear(interaction, player);
              break;
            case 'shuffle':
              await handleShuffle(interaction, player);
              break;
            case 'remove':
              await handleRemove(interaction, player);
              break;
            case 'volume':
              await handleVolume(interaction, player);
              break;
            case 'status':
              await handleStatus(interaction, player);
              break;
            case 'history':
              await handleHistory(interaction, player);
              break;
            case 'like':
              await handleLike(interaction, player);
              break;
            case 'dislike':
              await handleDislike(interaction, player);
              break;
            default:
              await interaction.reply({ content: `⚠️ Unknown control subcommand: ${sub}`, ephemeral: true });
          }
          break;
        }
        case 'station': {
          const sub = interaction.options.getSubcommand();
          switch (sub) {
            case 'preset':
              await handleRadio(interaction, player);
              break;
            case 'throwback':
              await handleThrowback(interaction, player);
              break;
            case 'morph':
              await handleMorph(interaction, player);
              break;
            case 'filter':
              await handleFilterCommand(interaction, player);
              break;
            case 'artist':
              await handleArtist(interaction, player);
              break;
            default:
              await interaction.reply({ content: `⚠️ Unknown station subcommand: ${sub}`, ephemeral: true });
          }
          break;
        }
        case 'taste':
          await handleTaste(interaction, player);
          break;
        case 'join':
          await handleJoin(interaction, player);
          break;
        case 'leave':
          await handleLeave(interaction, player);
          break;
        case 'artist':
          await handleArtist(interaction, player);
          break;
        case 'taste':
          await handleTaste(interaction, player);
          break;
        case 'throwback':
          await handleThrowback(interaction, player);
          break;
        case 'radio':
          await handleRadio(interaction, player);
          break;
        case 'morph':
          await handleMorph(interaction, player);
          break;
        case 'veto':
          await handleVeto(interaction, player);
          break;
        case 'skip':
          await handleSkip(interaction, player);
          break;
        case 'pause':
          await handlePause(interaction, player);
          break;
        case 'resume':
          await handleResume(interaction, player);
          break;
        case 'stop':
          await handleStop(interaction, player);
          break;
        case 'clear':
          await handleClear(interaction, player);
          break;
        case 'remove':
          await handleRemove(interaction, player);
          break;
        case 'shuffle':
          await handleShuffle(interaction, player);
          break;
        case 'replay':
          await handleReplay(interaction, player);
          break;
        case 'status':
          await handleStatus(interaction, player);
          break;
        case 'history':
          await handleHistory(interaction, player);
          break;
        case 'volume':
          await handleVolume(interaction, player);
          break;
        case 'like':
          await handleLike(interaction, player);
          break;
        case 'dislike':
          await handleDislike(interaction, player);
          break;
        case 'queue':
          await handleQueue(interaction, player);
          break;
        case 'join':
          await handleJoin(interaction, player);
          break;
        case 'leave':
          await handleLeave(interaction, player);
          break;
        case 'filter':
          await handleFilterCommand(interaction, player);
          break;
        default:
          console.warn(`[DiscordBot] Unrecognized command: ${interaction.commandName}`);
      }
    } catch (err) {
      console.error(`[DiscordBot] Error handling /${interaction.commandName}:`, (err as Error).message);
      const replyFn = interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
      await replyFn({ content: '❌ An error occurred executing this command.' }).catch(() => {});
    } finally {
      // Reposition now playing UI at the very bottom of the channel below the command output
      setTimeout(() => {
        playerUi.repositionToBottom();
      }, 500);
    }
  });

  // Handle Voice Channel Membership Updates with 8-second Debounce
  let membershipDebounceTimer: NodeJS.Timeout | null = null;

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    // Ignore bot voice state updates
    if (oldState.member?.user.bot || newState.member?.user.bot) return;

    // Check if voice channel changed
    if (oldState.channelId !== newState.channelId) {
      const activeChannelUserIds = player.getActiveListenerUserIds();
      // If someone joined or left the bot's current voice channel
      const isAffected =
        (oldState.channel && activeChannelUserIds.includes(oldState.member?.id || '')) ||
        (newState.channel && activeChannelUserIds.includes(newState.member?.id || ''));

      if (isAffected) {
        console.log(`[DiscordBot] Listener room transition: ${oldState.member?.displayName || 'User'} moved channels. Debouncing room re-curation (8s)...`);
        if (membershipDebounceTimer) {
          clearTimeout(membershipDebounceTimer);
        }
        membershipDebounceTimer = setTimeout(async () => {
          membershipDebounceTimer = null;
          await player.handleVoiceRoomMembershipChange();
        }, 8000);
      }
    }
  });

  return client;
}

export default createDiscordBot;
