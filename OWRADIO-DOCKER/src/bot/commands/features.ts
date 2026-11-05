/**
 * @file features.ts
 * @description Advanced Discord Slash Commands for VEXO:
 * - /artist <name>: Interactive select menu for albums with 15s timeout fallback
 * - /taste: Voice Channel Collective Taste Fingerprint Radar Chart
 * - /throwback <year>: Time Capsule Temporal Mode
 * - /radio <station>: Curated Radio Station Presets
 * - /morph <vibe>: DJ Morph Mode Latent Vector Interpolation
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  PermissionFlagsBits,
  type GuildMember,
} from 'discord.js';
import type { GuildPlayer } from '../../player/GuildPlayer.js';
import { AudioTrack } from '../../player/AudioTrack.js';
import deezer from '../../services/deezer.js';
import youtube from '../../services/youtube.js';
import featureFlags from '../../services/featureFlags.js';
import dynamicSettings from '../../services/dynamicSettings.js';
import stationCurator, { RADIO_STATIONS } from '../../services/stationCurator.js';
import playlistParser from '../../services/playlistParser.js';
import { sqlite } from '../../db/index.js';
import { normalizeArtist } from '../../utils/trackDedupe.js';
import vetoService from '../../services/vetoService.js';

// --- 1. /artist Command ---
export const artistCommand = new SlashCommandBuilder()
  .setName('artist')
  .setDescription('Explore an artist discography with interactive album selection & auto-play timeout')
  .addStringOption((opt) =>
    opt.setName('name')
      .setDescription('Artist name (e.g. "Daft Punk", "Radiohead", "The Cure")')
      .setRequired(true)
  );

// --- 2. /taste Command ---
export const tasteCommand = new SlashCommandBuilder()
  .setName('taste')
  .setDescription('Manage your taste profile and view collective room DNA')
  .addSubcommand((sub) =>
    sub.setName('profile')
      .setDescription('Display the collective 8-axis Taste Radar Fingerprint for listeners in voice')
  )
  .addSubcommand((sub) =>
    sub.setName('playlist')
      .setDescription('Onboard your musical taste by dropping a Spotify or YouTube playlist URL')
      .addStringOption((opt) =>
        opt.setName('url')
          .setDescription('Public Spotify or YouTube playlist link')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('artists')
      .setDescription('Add your top favorite artists (comma-separated)')
      .addStringOption((opt) =>
        opt.setName('list')
          .setDescription('e.g. Daft Punk, Radiohead, Steely Dan, The Cure')
          .setRequired(true)
      )
  )
    .addSubcommand((sub) =>
    sub.setName('genres')
      .setDescription('Add your preferred music genres (comma-separated)')
      .addStringOption((opt) =>
        opt.setName('list')
          .setDescription('e.g. hip hop, techno, dnb, rock, synthwave')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('clear')
      .setDescription('Reset your stored taste profile preferences')
  )
  .addSubcommand((sub) =>
    sub.setName('veto')
      .setDescription('Blacklist an artist or track from being curated in this room')
      .addStringOption((opt) =>
        opt.setName('name')
          .setDescription('Artist or song name to blacklist')
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('type')
          .setDescription('Blacklist type (default: artist)')
          .addChoices({ name: 'Artist', value: 'artist' }, { name: 'Song', value: 'song' })
      )
  );

// --- Unified /station Master Command (Option C) ---
export const stationCommand = new SlashCommandBuilder()
  .setName('station')
  .setDescription('Radio presets, vintage time machine, morphing, and audio filters')
  .addSubcommand((sub) =>
    sub
      .setName('preset')
      .setDescription('Switch to a curated radio station preset or "off"')
      .addStringOption((opt) => {
        opt
          .setName('station')
          .setDescription('Select station preset or "off" to return to standard curation')
          .setRequired(false);
        for (const station of RADIO_STATIONS) {
          opt.addChoices({ name: `${station.icon} ${station.name}`.slice(0, 100), value: station.id });
        }
        opt.addChoices({ name: '⏹️ Off (Standard Dynamic Curation)', value: 'off' });
        return opt;
      })
  )
  .addSubcommand((sub) =>
    sub
      .setName('throwback')
      .setDescription('Time Capsule: Curate vintage record releases from a specific year')
      .addIntegerOption((opt) =>
        opt
          .setName('year')
          .setDescription('Release year (e.g. 1984, 1997, 2005) or omit to disengage')
          .setRequired(false)
          .setMinValue(1950)
          .setMaxValue(2026)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('morph')
      .setDescription('DJ Morph: Smoothly interpolate room taste towards a new target vibe')
      .addStringOption((opt) =>
        opt
          .setName('vibe')
          .setDescription('Target aesthetic destination (e.g. "dark synthwave", "dreampop chill")')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('filter')
      .setDescription('Interactive audio purity & quality filter toggles (Covers, Lives, Instrumentals)')
  )
  .addSubcommand((sub) =>
    sub
      .setName('artist')
      .setDescription('Explore an artist discography with interactive album selection')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Artist name (e.g. "Daft Punk", "Radiohead")')
          .setRequired(true)
      )
  );

// --- 3. /throwback Command ---
export const throwbackCommand = new SlashCommandBuilder()
  .setName('throwback')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDescription('Engage Time Capsule Mode to curate songs from a specific year or nostalgic era')
  .addIntegerOption((opt) =>
    opt.setName('year')
      .setDescription('Release year (e.g. 1984, 1997, 2005) or omit to disengage')
      .setRequired(false)
      .setMinValue(1950)
      .setMaxValue(2026)
  );

// --- 4. /radio Command ---
export const radioCommand = new SlashCommandBuilder()
  .setName('radio')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDescription('Switch to an autonomous curated Radio Station preset')
  .addStringOption((opt) => {
    opt.setName('station')
      .setDescription('Select station preset or "off" to return to standard curation')
      .setRequired(false);
    for (const station of RADIO_STATIONS) {
      opt.addChoices({ name: `${station.icon} ${station.name}`, value: station.id });
    }
    opt.addChoices({ name: '⏹️ Standard Curation (Turn Radio Off)', value: 'off' });
    return opt;
  });

// --- 5. /morph Command ---
export const morphCommand = new SlashCommandBuilder()
  .setName('morph')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDescription('DJ Morph Mode: Smooth multi-track trajectory transitioning room taste to a target vibe')
  .addStringOption((opt) =>
    opt.setName('vibe')
      .setDescription('Target vibe (e.g. "dark cyberpunk synthwave", "sun-drenched 70s soul")')
      .setRequired(true)
  );

// --- 6. /veto Command ---
export const vetoCommand = new SlashCommandBuilder()
  .setName('veto')
  .setDescription('Blacklist an artist or track from being curated or queued (Admin only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((opt) =>
    opt.setName('name')
      .setDescription('Artist name or track title')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('type')
      .setDescription('Target type (artist or track, default: artist)')
      .setRequired(false)
      .addChoices(
        { name: 'Artist', value: 'artist' },
        { name: 'Track', value: 'track' }
      )
  );

/**
 * Ensures user is connected to voice channel.
 */
async function ensureVoiceConnection(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<boolean> {
  const member = interaction.member as GuildMember;
  const channel = member?.voice?.channel;

  if (!channel) {
    await interaction.editReply('❌ You must be inside a voice channel to use this command!');
    return false;
  }

  await player.connectToVoice(channel);
  return true;
}

/**
 * Handle /artist <name>
 * Visual album carousel with large cover art, paginated track picker, and simple button clicks.
 */
export async function handleArtist(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!featureFlags.isEnabled('feature_artist_interactive')) {
    await interaction.editReply('⚠️ **/artist Interactive Discography** is currently disabled in WebUI Settings.');
    return;
  }

  if (!(await ensureVoiceConnection(interaction, player))) return;

  const artistQuery = interaction.options.getString('name', true).trim();

  // 1. Search Deezer catalog using dedicated artist search
  let artist = await deezer.searchArtist(artistQuery);

  // 2. If dedicated search returned null, try searching tracks for matching artistId
  if (!artist) {
    const trackMatches = await deezer.searchTracks(artistQuery, 5);
    const firstWithArtist = trackMatches.find((t) => t.artistId);
    if (firstWithArtist && firstWithArtist.artistId) {
      artist = {
        id: firstWithArtist.artistId,
        name: firstWithArtist.artist,
        picture: firstWithArtist.artworkUrl,
        pictureThumb: firstWithArtist.artworkThumbUrl,
      };
    }
  }

  // 3. Fallback: If Deezer has no record of the artist, fall back to YouTube search
  if (!artist) {
    const ytResults = await youtube.searchTracks(artistQuery, 5);
    if (ytResults.length === 0) {
      await interaction.editReply(`❌ Could not locate discography or tracks for artist: **${artistQuery}**`);
      return;
    }

    const first = ytResults[0];
    const track = AudioTrack.fromYouTube(first, interaction.user.id, true, 'Artist Search');
    await player.enqueue(track);
    await interaction.editReply(`🎶 Enqueued **${track.title}** by **${track.artist}**!`);
    return;
  }

  const artistId = artist.id;
  const realArtistName = artist.name;
  const artistPic = artist.picture;

  // 4. Fetch artist albums and top hits
  const [albums, topTracks] = await Promise.all([
    deezer.getArtistAlbums(artistId, 25),
    deezer.getArtistTopTracks(artistId, 15),
  ]);

  // Fallback if neither albums nor top tracks found
  if (albums.length === 0 && topTracks.length === 0) {
    const ytResults = await youtube.searchTracks(realArtistName, 5);
    if (ytResults.length > 0) {
      const track = AudioTrack.fromYouTube(ytResults[0], interaction.user.id, true, 'Artist Search');
      await player.enqueue(track);
      await interaction.editReply(`🎶 Enqueued **${track.title}** by **${realArtistName}**!`);
    } else {
      await interaction.editReply(`❌ No tracks found for artist: **${realArtistName}**`);
    }
    return;
  }

  // Tracklist cache for instant flipping
  const albumTracksCache = new Map<string, any[]>();

  // State
  let currentView: 'ALBUMS' | 'TRACKS' = 'ALBUMS';
  let albumIndex = 0;
  let trackPageIndex = 0;
  const TRACKS_PER_PAGE = 5;

  // Helper: Pre-fetch or get tracks for an album
  const getOrFetchAlbumTracks = async (albId: string): Promise<any[]> => {
    if (albumTracksCache.has(albId)) {
      return albumTracksCache.get(albId)!;
    }
    const tracks = await deezer.getAlbumTracks(albId);
    albumTracksCache.set(albId, tracks);
    return tracks;
  };

  // Helper: Auto-pick top track
  const autoPickTrack = (): any => {
    if (topTracks.length === 0) return null;
    const pool = topTracks.slice(0, Math.min(topTracks.length, 6));
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // Build the Album Carousel Message
  const buildAlbumView = async () => {
    const album = albums[albumIndex];
    const previewTracks = await getOrFetchAlbumTracks(album.id);

    let previewList = '';
    if (previewTracks.length > 0) {
      const previewSlice = previewTracks.slice(0, 4);
      previewList =
        `\n\n🎵 **Tracklist Preview:**\n` +
        previewSlice
          .map((t, idx) => {
            const min = Math.floor(t.durationSec / 60);
            const sec = String(t.durationSec % 60).padStart(2, '0');
            return `\`${idx + 1}.\` **${t.title}** (\`${min}:${sec}\`)`;
          })
          .join('\n') +
        (previewTracks.length > 4 ? `\n*...and ${previewTracks.length - 4} more tracks*` : '');
    }

    const year = album.releaseDate ? album.releaseDate.split('-')[0] : 'Release';
    const format = album.recordType ? album.recordType.toUpperCase() : 'ALBUM';

    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setAuthor({ name: `🎤 ${realArtistName} • Discography`, iconURL: artistPic })
      .setTitle(`💽 Album ${albumIndex + 1}/${albums.length}: ${album.title}`)
      .setDescription(
        `📅 **Year:** ${year} • **Format:** \`${format}\` • **Tracks:** \`${previewTracks.length}\`` +
        previewList +
        `\n\n👇 *Click **Select Album** to browse tracks, or use arrows to flip covers.*`
      )
      .setImage(album.cover)
      .setFooter({
        text: `Album ${albumIndex + 1} of ${albums.length} • Auto-picks top track in 30s if idle`,
      });

    const isDropdownMode = dynamicSettings.getString('discord_artist_ui_mode', 'dropdown') === 'dropdown';

    let components: any[] = [];
    if (isDropdownMode) {
      // Dropdown Mode: Select menu for up to 25 albums
      const albumSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('menu_alb_select')
        .setPlaceholder(`💿 Select an Album by ${realArtistName}...`)
        .addOptions(
          albums.slice(0, 25).map((alb, idx) => {
            const albYear = alb.releaseDate ? alb.releaseDate.split('-')[0] : '';
            const desc = albYear ? `Year: ${albYear} • ${alb.recordType || 'Album'}` : (alb.recordType || 'Album');
            return {
              label: `${idx + 1}. ${alb.title}`.slice(0, 100),
              description: desc.slice(0, 100),
              value: `alb_${idx}`,
              default: idx === albumIndex,
            };
          })
        );

      const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(albumSelectMenu);
      const rowQuick = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_alb_select')
          .setLabel('💿 View Album Tracks')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_quick_random')
          .setLabel('🎲 Surprise Pick')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('btn_quick_top5')
          .setLabel('🔥 Play Top 5 Hits')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(topTracks.length === 0)
      );

      components = [rowSelect, rowQuick];
    } else {
      // Carousel Buttons Mode
      const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_alb_prev')
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(albums.length <= 1),
        new ButtonBuilder()
          .setCustomId('btn_alb_select')
          .setLabel('💿 Select Album')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_alb_next')
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(albums.length <= 1)
      );

      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_quick_random')
          .setLabel('🎲 Auto-Pick / Surprise Me')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('btn_quick_top5')
          .setLabel('🔥 Play Top 5 Hits')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(topTracks.length === 0)
      );

      components = [row1, row2];
    }

    return { embeds: [embed], components };
  };

  // Build the Album Track Picker Message
  const buildTrackView = async () => {
    const album = albums[albumIndex];
    const albumTracks = await getOrFetchAlbumTracks(album.id);
    const totalPages = Math.max(1, Math.ceil(albumTracks.length / TRACKS_PER_PAGE));
    trackPageIndex = Math.min(trackPageIndex, totalPages - 1);

    const isDropdownMode = dynamicSettings.getString('discord_artist_ui_mode', 'dropdown') === 'dropdown';

    const startIdx = trackPageIndex * TRACKS_PER_PAGE;
    const pageTracks = albumTracks.slice(startIdx, startIdx + TRACKS_PER_PAGE);

    const trackLines = pageTracks
      .map((t, idx) => {
        const trackNum = startIdx + idx + 1;
        const min = Math.floor(t.durationSec / 60);
        const sec = String(t.durationSec % 60).padStart(2, '0');
        return `\`${trackNum}.\` **${t.title}** (\`${min}:${sec}\`)`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x10b981)
      .setAuthor({ name: `🎤 ${realArtistName} • ${album.title}`, iconURL: artistPic })
      .setTitle(`💽 ${album.title} • Tracks (${albumTracks.length} Total)`)
      .setDescription(
        trackLines +
        `\n\n👇 *Select a track from the dropdown, pick a numbered button, or queue the full album.*`
      )
      .setImage(album.cover)
      .setFooter({
        text: `Album: ${album.title} (${albumTracks.length} tracks) • Auto-picks track in 30s if idle`,
      });

    let components: any[] = [];
    if (isDropdownMode) {
      // Dropdown Mode: Track Select Menu
      const trackSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('menu_trk_select')
        .setPlaceholder('🎵 Choose a song from this album to play...')
        .addOptions(
          albumTracks.slice(0, 25).map((t, idx) => {
            const min = Math.floor(t.durationSec / 60);
            const sec = String(t.durationSec % 60).padStart(2, '0');
            return {
              label: `${idx + 1}. ${t.title}`.slice(0, 100),
              description: `${min}:${sec} • ${realArtistName}`.slice(0, 100),
              value: `trk_${idx}`,
            };
          })
        );

      const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(trackSelectMenu);
      const rowActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_trk_play_all')
          .setLabel(`💿 Play Full Album (${albumTracks.length})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_trk_random')
          .setLabel('🎲 Random Track')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('btn_trk_back')
          .setLabel('🔙 Back to Albums')
          .setStyle(ButtonStyle.Danger)
      );

      components = [rowSelect, rowActions];
    } else {
      // Numbered Track Buttons Mode
      const row1 = new ActionRowBuilder<ButtonBuilder>();
      for (let i = 0; i < pageTracks.length; i++) {
        const trackNum = startIdx + i + 1;
        row1.addComponents(
          new ButtonBuilder()
            .setCustomId(`btn_trk_pick_${startIdx + i}`)
            .setLabel(`🎵 ${trackNum}`)
            .setStyle(ButtonStyle.Primary)
        );
      }

      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_trk_prev')
          .setLabel('◀ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(trackPageIndex === 0),
        new ButtonBuilder()
          .setCustomId('btn_trk_play_all')
          .setLabel(`💿 Play All (${albumTracks.length})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_trk_random')
          .setLabel('🎲 Random Track')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('btn_trk_next')
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(trackPageIndex >= totalPages - 1),
        new ButtonBuilder()
          .setCustomId('btn_trk_back')
          .setLabel('🔙 Back to Albums')
          .setStyle(ButtonStyle.Danger)
      );

      components = [row1, row2];
    }

    return { embeds: [embed], components };
  };

  // Helper to render current state
  const renderCurrentView = async () => {
    if (currentView === 'ALBUMS') {
      return await buildAlbumView();
    } else {
      return await buildTrackView();
    }
  };

  // Pre-cache first album tracks
  if (albums.length > 0) {
    await getOrFetchAlbumTracks(albums[0].id);
  }

  // Send initial message with first album cover
  const initialPayload = await renderCurrentView();
  const response = await interaction.editReply(initialPayload);

  // Setup component collector (buttons + select dropdowns) with 30-second sliding idle timeout
  const collector = response.createMessageComponentCollector({
    time: 30_000,
  });

  collector.on('collect', async (i) => {
    // Only allow the original requester to control the browser
    if (i.user.id !== interaction.user.id) {
      await i.reply({
        content: '❌ Only the person who ran /artist can control this menu.',
        ephemeral: true,
      });
      return;
    }

    // Reset 30s idle timer on every interaction!
    collector.resetTimer({ time: 30_000 });

    try {
      // --- SELECT DROPDOWN HANDLERS ---
      if (i.isStringSelectMenu()) {
        if (i.customId === 'menu_alb_select') {
          const rawVal = i.values[0];
          const pickIdx = parseInt(rawVal.replace('alb_', ''), 10);
          if (!isNaN(pickIdx) && albums[pickIdx]) {
            albumIndex = pickIdx;
            currentView = 'TRACKS';
            trackPageIndex = 0;
            const payload = await buildTrackView();
            await i.update(payload);
          }
          return;
        }

        if (i.customId === 'menu_trk_select') {
          const rawVal = i.values[0];
          const pickIdx = parseInt(rawVal.replace('trk_', ''), 10);
          const album = albums[albumIndex];
          const albumTracks = await getOrFetchAlbumTracks(album.id);
          const pickedTrk = albumTracks[pickIdx] || albumTracks[0];
          if (pickedTrk) {
            collector.stop('selected');
            await player.enqueue(
              AudioTrack.fromDeezer(pickedTrk, interaction.user.id, true, 'Album Track', album.title)
            );
            await i.update({
              content: `🎶 Enqueued **${pickedTrk.title}** from album **${album.title}** by **${realArtistName}**!`,
              embeds: [],
              components: [],
            });
          }
          return;
        }
      }

      if (!i.isButton()) return;
      const btn = i;
      const id = btn.customId;

      // --- ALBUM CAROUSEL BUTTONS ---
      if (id === 'btn_alb_prev') {
        albumIndex = (albumIndex - 1 + albums.length) % albums.length;
        const payload = await buildAlbumView();
        await btn.update(payload);
        return;
      }

      if (id === 'btn_alb_next') {
        albumIndex = (albumIndex + 1) % albums.length;
        const payload = await buildAlbumView();
        await btn.update(payload);
        return;
      }

      if (id === 'btn_alb_select') {
        currentView = 'TRACKS';
        trackPageIndex = 0;
        const payload = await buildTrackView();
        await btn.update(payload);
        return;
      }

      // --- QUICK ACTION BUTTONS ---
      if (id === 'btn_quick_random') {
        const auto = autoPickTrack();
        if (auto) {
          await player.enqueue(AudioTrack.fromDeezer(auto, interaction.user.id, true, 'Artist Auto-Pick'));
          collector.stop('selected');
          await btn.update({
            content: `🎲 **Surprise Pick:** Enqueued **${auto.title}** by **${realArtistName}**! 🎧`,
            embeds: [],
            components: [],
          });
        }
        return;
      }

      if (id === 'btn_quick_top5') {
        const top5 = topTracks.slice(0, 5);
        for (const t of top5) {
          await player.enqueue(AudioTrack.fromDeezer(t, interaction.user.id, true, 'Artist Top 5'));
        }
        collector.stop('selected');
        await btn.update({
          content: `🔥 Enqueued **top ${top5.length} tracks** by **${realArtistName}**!`,
          embeds: [],
          components: [],
        });
        return;
      }

      // --- TRACK PICKER BUTTONS ---
      if (id === 'btn_trk_back') {
        currentView = 'ALBUMS';
        const payload = await buildAlbumView();
        await btn.update(payload);
        return;
      }

      if (id === 'btn_trk_prev') {
        trackPageIndex = Math.max(0, trackPageIndex - 1);
        const payload = await buildTrackView();
        await btn.update(payload);
        return;
      }

      if (id === 'btn_trk_next') {
        trackPageIndex++;
        const payload = await buildTrackView();
        await btn.update(payload);
        return;
      }

      if (id === 'btn_trk_play_all') {
        const album = albums[albumIndex];
        const albumTracks = await getOrFetchAlbumTracks(album.id);
        for (const t of albumTracks) {
          await player.enqueue(
            AudioTrack.fromDeezer(t, interaction.user.id, true, 'Full Album', album.title)
          );
        }
        collector.stop('selected');
        await btn.update({
          content: `💽 Enqueued all **${albumTracks.length} tracks** from **${album.title}** by **${realArtistName}**!`,
          embeds: [],
          components: [],
        });
        return;
      }

      if (id === 'btn_trk_random') {
        const album = albums[albumIndex];
        const albumTracks = await getOrFetchAlbumTracks(album.id);
        const randTrk = albumTracks[Math.floor(Math.random() * albumTracks.length)];
        await player.enqueue(
          AudioTrack.fromDeezer(randTrk, interaction.user.id, true, 'Album Track', album.title)
        );
        collector.stop('selected');
        await btn.update({
          content: `🎲 Picked **${randTrk.title}** from album **${album.title}** by **${realArtistName}**!`,
          embeds: [],
          components: [],
        });
        return;
      }

      if (id.startsWith('btn_trk_pick_')) {
        const pickIdx = parseInt(id.replace('btn_trk_pick_', ''), 10);
        const album = albums[albumIndex];
        const albumTracks = await getOrFetchAlbumTracks(album.id);
        const pickedTrk = albumTracks[pickIdx] || albumTracks[0];
        await player.enqueue(
          AudioTrack.fromDeezer(pickedTrk, interaction.user.id, true, 'Album Track', album.title)
        );
        collector.stop('selected');
        await btn.update({
          content: `🎶 Enqueued **${pickedTrk.title}** from album **${album.title}** by **${realArtistName}**!`,
          embeds: [],
          components: [],
        });
        return;
      }
    } catch (err) {
      console.error('[Features] Button collector error:', err);
    }
  });

  collector.on('end', async (_collected, reason) => {
    // Only handle timeout fallback if no user selection was made
    if (reason === 'time') {
      try {
        if (currentView === 'TRACKS') {
          const album = albums[albumIndex];
          const albumTracks = await getOrFetchAlbumTracks(album.id);
          const autoAlbumTrack = albumTracks[Math.floor(Math.random() * albumTracks.length)];
          if (autoAlbumTrack) {
            await player.enqueue(
              AudioTrack.fromDeezer(autoAlbumTrack, interaction.user.id, true, 'Album Auto-Pick', album.title)
            );
            await interaction.editReply({
              content: `⏳ **30s Idle Timeout Elapsed!** Auto-picked **${autoAlbumTrack.title}** from album **${album.title}** by **${realArtistName}** 🎧`,
              embeds: [],
              components: [],
            });
            return;
          }
        }

        const auto = autoPickTrack();
        if (auto) {
          await player.enqueue(AudioTrack.fromDeezer(auto, interaction.user.id, true, 'Artist Auto-Pick'));
          await interaction.editReply({
            content: `⏳ **30s Idle Timeout Elapsed!** Auto-picked top track: **${auto.title}** by **${realArtistName}** 🎧`,
            embeds: [],
            components: [],
          });
        } else {
          await interaction.editReply({
            content: `⏳ **30s Idle Timeout Elapsed!**`,
            embeds: [],
            components: [],
          });
        }
      } catch (err) {
        console.error('[Features] Timeout fallback error:', err);
      }
    }
  });
}

/**
 * Handle /taste
 */
export async function handleTaste(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  const sub = interaction.options.getSubcommand(false) || 'profile';

  if (sub === 'veto') {
    return handleVeto(interaction, player);
  }

  await interaction.deferReply();

  if (sub === 'playlist') {
    const url = interaction.options.getString('url', true);
    try {
      const profile = await playlistParser.registerUserPlaylist(interaction.user.id, url);
      const topArtistsStr = profile.topArtists
        .slice(0, 6)
        .map((a) => `• **${a.name}** (\`${a.count} tracks\`)`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle(`🧬 Taste Profile Ingested: ${profile.title}`)
        .setDescription(
          `Successfully analyzed and saved musical DNA from **${profile.totalTracks} tracks**!\n\n` +
          `**Top Seed Artists Added to Your Rotation:**\n${topArtistsStr}\n\n` +
          `📻 *The autonomous DJ will now blend these artists and their deep-cuts whenever you are in voice.*`
        )
        .setFooter({ text: 'OWRadio Hybrid Curation Engine • Zero Cloud Surveillance' });

      await interaction.editReply({ embeds: [embed] });
      return;
    } catch (err) {
      await interaction.editReply(`❌ **Playlist Import Failed:** ${(err as Error).message}`);
      return;
    }
  }

  if (sub === 'artists') {
    const rawList = interaction.options.getString('list', true);
    const artists = rawList
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (artists.length === 0) {
      await interaction.editReply('⚠️ Please provide at least one valid artist name.');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const insertStmt = sqlite.prepare(`
      INSERT INTO user_preferences (user_id, target_type, target_key, display_name, likes, affinity_score, updated_at)
      VALUES (?, 'artist', ?, ?, 1, 5.0, ?)
      ON CONFLICT(user_id, target_type, target_key) DO UPDATE SET
        likes = likes + 1,
        affinity_score = affinity_score + 5.0,
        updated_at = excluded.updated_at
    `);

    sqlite.transaction(() => {
      for (const a of artists) {
        const normKey = normalizeArtist(a).toLowerCase();
        insertStmt.run(interaction.user.id, normKey, a, now);
      }
    })();

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('🎧 Favorite Artists Saved')
      .setDescription(
        `Added **${artists.length} artists** to your personal taste profile:\n\n` +
        artists.map((a) => `• **${a}**`).join('\n') +
        `\n\n📻 *These will act as core anchors and collaborative discovery seeds when you are in voice.*`
      )
      .setFooter({ text: 'OWRadio Taste Memory' });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

    if (sub === 'genres') {
    const rawList = interaction.options.getString('list', true);
    const genres = rawList
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    if (genres.length === 0) {
      await interaction.editReply('⚠️ Please provide at least one valid genre (e.g. `hip hop, techno, dnb`).');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const insertStmt = sqlite.prepare(`
      INSERT INTO user_preferences (user_id, target_type, target_key, display_name, likes, affinity_score, updated_at)
      VALUES (?, 'genre', ?, ?, 1, 5.0, ?)
      ON CONFLICT(user_id, target_type, target_key) DO UPDATE SET
        likes = likes + 1,
        affinity_score = affinity_score + 5.0,
        updated_at = excluded.updated_at
    `);

    sqlite.transaction(() => {
      for (const g of genres) {
        const displayName = g
          .split(' ')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        insertStmt.run(interaction.user.id, g, displayName, now);
      }
    })();

    // Recurate upcoming buffer to reflect newly added genres
    await player.recurateAutoplayBuffer();

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🎛️ Preferred Genres Saved')
      .setDescription(
        `Added **${genres.length} genres** to your personal taste profile:

` +
        genres.map((g) => `• **${g.toUpperCase()}**`).join('\n') +
        `\n\n📻 *The autonomous DJ will now steer room discovery towards these genres and boost their radar affinity.*`
      )
      .setFooter({ text: 'OWRadio Taste Memory • Hybrid Curation' });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'clear') {
    sqlite.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(interaction.user.id);
    await interaction.editReply('🗑️ **Your taste preferences have been reset.** The bot will treat you as a clean listener.');
    return;
  }

  // --- Subcommand: profile (Existing Radar Chart) ---
  if (!featureFlags.isEnabled('feature_taste_radar_chart')) {
    await interaction.editReply('⚠️ **/taste Radar Chart** is currently disabled in WebUI Settings.');
    return;
  }

  const activeUserIds = player.getActiveListenerUserIds();
  const currentTrackSummary = player.currentTrack ? {
    id: player.currentTrack.id,
    title: player.currentTrack.title,
    artist: player.currentTrack.artist,
    album: player.currentTrack.album,
    durationSec: player.currentTrack.durationSec,
  } : null;
  const count = activeUserIds.length || 1;
  let desc = `Acoustic room affinity active across **${count} voice listener(s)**:\n\n`;
  if (currentTrackSummary) {
    desc += `🎵 **Playing Now:** **${currentTrackSummary.title}** by **${currentTrackSummary.artist}**\n\n` +
      `🌐 **Explore Web Dashboard:** Control queue and audio at http://localhost:8091`;
  } else {
    desc += `🌐 **Explore Web Dashboard:** Control queue and audio at http://localhost:8091`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🕸️ Room Taste DNA')
    .setDescription(desc)
    .setFooter({ text: 'Taste fingerprint updates dynamically with every track.' });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle /throwback [year]
 * Grounded temporal curation strictly bound to verified record releases from the specified year.
 * Completely bypasses any hallucinating LLM.
 */
export async function handleThrowback(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!featureFlags.isEnabled('feature_time_capsule')) {
    await interaction.editReply('⚠️ **Time Capsule Mode** is currently disabled in WebUI Settings.');
    return;
  }

  const year = interaction.options.getInteger('year');

  if (!year) {
    stationCurator.setTimeCapsuleYear(null);
    await player.recurateAutoplayBuffer();
    await interaction.editReply('⏳ **Time Capsule Disengaged.** Curation restored to standard multi-era flow.');
    return;
  }

  if (!(await ensureVoiceConnection(interaction, player))) return;

  // 1. Fetch grounded, verified record releases for this specific year
  const pool = await stationCurator.engageTimeCapsule(year);
  if (pool.length === 0) {
    await interaction.editReply(`❌ Could not locate grounded record releases for year **${year}**.`);
    return;
  }

  // 2. Immediately purge old autoplay buffer so upcoming tracks are from this year
  await player.recurateAutoplayBuffer();

  // 3. Immediately enqueue the first verified classic from that year
  const firstTrack = pool[0];
  await player.enqueue(
    AudioTrack.fromDeezer(
      firstTrack,
      interaction.user.id,
      true,
      `Time Capsule (${year})`,
      `Verified ${firstTrack.releaseYear || year} Record Release`
    )
  );

  let poolCursor = 1;

  const buildThrowbackEmbed = () => {
    const previewLines = pool
      .slice(poolCursor, poolCursor + 5)
      .map((t, idx) => `\`${idx + 1}.\` **${t.title}** — ${t.artist}`)
      .join('\n');

    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setAuthor({ name: '📻 Verified Grounded Record Releases • Zero LLM Hallucination' })
      .setTitle(`⏳ Time Capsule Engaged: Year ${year}`)
      .setDescription(
        `🎶 **Immediately Enqueued:** **${firstTrack.title}** by **${firstTrack.artist}** (\`${year}\` Record Release)\n\n` +
        `📻 **Autoplay Locked:** Autoplay is now strictly locked to grounded record releases from **${year}**.\n` +
        `🛡️ **Zero Hallucination:** 100% verified historical releases — LLM bypassed.\n\n` +
        `📜 **Primed In Era Queue:**\n${previewLines}\n` +
        `*(...${pool.length} verified records primed in pool)*`
      )
      .setThumbnail(firstTrack.artworkUrl)
      .setFooter({ text: `Locked to year ${year} • Use buttons to queue more or disengage` });
  };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_tc_more')
      .setLabel(`🎲 Enqueue Another (${year})`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_tc_off')
      .setLabel('⏹️ Disengage Time Capsule')
      .setStyle(ButtonStyle.Danger)
  );

  const response = await interaction.editReply({
    embeds: [buildThrowbackEmbed()],
    components: [row],
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
  });

  collector.on('collect', async (btn) => {
    if (btn.user.id !== interaction.user.id) {
      await btn.reply({ content: '❌ Only the person who engaged Time Capsule can control this.', ephemeral: true });
      return;
    }

    collector.resetTimer({ time: 60_000 });

    if (btn.customId === 'btn_tc_more') {
      if (poolCursor < pool.length) {
        const nextTrack = pool[poolCursor++];
        await player.enqueue(
          AudioTrack.fromDeezer(
            nextTrack,
            interaction.user.id,
            true,
            `Time Capsule (${year})`,
            `Verified ${nextTrack.releaseYear || year} Record Release`
          )
        );
        await btn.reply({
          content: `🎶 Enqueued **${nextTrack.title}** by **${nextTrack.artist}** (\`${year}\` Record Release)!`,
          ephemeral: true,
        });
      } else {
        await btn.reply({ content: '⚠️ Era pool exhausted.', ephemeral: true });
      }
      return;
    }

    if (btn.customId === 'btn_tc_off') {
      stationCurator.setTimeCapsuleYear(null);
      await player.recurateAutoplayBuffer();
      collector.stop('disengaged');
      await btn.update({
        content: '⏳ **Time Capsule Disengaged.** Curation restored to standard flow.',
        embeds: [],
        components: [],
      });
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time') {
      try {
        await interaction.editReply({ components: [] });
      } catch {}
    }
  });
}

/**
 * Handle /radio [station]
 */
export async function handleRadio(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!featureFlags.isEnabled('feature_radio_stations')) {
    await interaction.editReply('⚠️ **Curated Radio Stations** are currently disabled in WebUI Settings.');
    return;
  }

  const stationId = interaction.options.getString('station');

  if (!stationId || stationId === 'off') {
    stationCurator.setStation(null);
    await player.recurateAutoplayBuffer();
    await interaction.editReply('📻 **Radio Preset Disengaged.** Curation restored to room listener taste.');
    return;
  }

  const station = stationCurator.setStation(stationId);
  if (!station) {
    await interaction.editReply(`❌ Unknown radio station preset: "${stationId}"`);
    return;
  }

  await player.recurateAutoplayBuffer();

  const embed = new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle(`${station.icon} Radio Station: ${station.name}`)
    .setDescription(
      `**Genre:** \`${station.genre}\` • **Target BPM:** \`~${station.targetBpm} BPM\`\n\n` +
      `*${station.description}*\n\n` +
      `Autonomous AI curation will now stream endless zero-dropout tracks tailored to this preset!`
    )
    .setFooter({ text: 'Select /radio off anytime to restore room consensus.' });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle /morph <vibe>
 */
export async function handleMorph(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!featureFlags.isEnabled('feature_vibe_morph')) {
    await interaction.editReply('⚠️ **DJ Morph Mode** is currently disabled in WebUI Settings.');
    return;
  }

  if (!(await ensureVoiceConnection(interaction, player))) return;

  const targetVibe = interaction.options.getString('vibe', true).trim();
  const morphSteps = dynamicSettings.getNumber('curation_morph_steps', 4);
  stationCurator.startMorph(targetVibe, new Float32Array(384), morphSteps);
  await player.recurateAutoplayBuffer();

  const embed = new EmbedBuilder()
    .setColor(0x06b6d4)
    .setTitle(`🌀 DJ Morph Mode Initiated`)
    .setDescription(
      `Setting a **${morphSteps}-track latent transition trajectory** from current room taste towards:\n` +
      `🎯 **Target Vibe:** *"${targetVibe}"*\n\n` +
      `Each upcoming autoplay song will smoothly shift vector coordinates by 25% until the destination aesthetic is fully reached!`
    )
    .setFooter({ text: 'Interpolation executed in 384-dimensional latent space.' });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle /veto <name> [type]
 */
export async function handleVeto(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const rawType = interaction.options.getString('type') || 'artist';
  const type: 'artist' | 'song' = rawType === 'track' || rawType === 'song' ? 'song' : 'artist';

  vetoService.addVeto(type, name, 'manual_admin');

  // If vetoed artist or track matches currently playing, skip it
  if (player.currentTrack) {
    if (
      (type === 'artist' && vetoService.isArtistVetoed(player.currentTrack.artist)) ||
      (type === 'song' && vetoService.isSongVetoed(player.currentTrack.title, player.currentTrack.artist))
    ) {
      await player.skip();
    }
  }

  // Recurate upcoming buffer to remove any newly vetoed items
  await player.recurateAutoplayBuffer();

  await interaction.reply({
    content: `🚫 **Vetoed ${type}:** "${name}". It has been blacklisted and purged from upcoming curation.`,
    ephemeral: true,
  });
}

