/**
 * @file bot/playerUi.ts
 * @description Clean Discord Now Playing Embed & Interactive Control Buttons.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { GuildPlayer } from '../player/GuildPlayer.js';

export function buildNowPlayingPayload(player: GuildPlayer) {
  const track = player.currentTrack;
  if (!track) {
    const idleEmbed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle('📻 OWRadio — Ready')
      .setDescription('Use `/play` or the Web Dashboard to start streaming 100% real studio audio.');
    return { embeds: [idleEmbed], components: [] };
  }

  const elapsed = player.getElapsedSeconds();
  const dur = track.duration || 0;
  const pct = dur > 0 ? Math.min(1, Math.max(0, elapsed / dur)) : 0;
  const filled = Math.round(pct * 16);
  const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, 16 - filled));

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const lines = [
    `**Artist:** ${track.artist}`,
    track.album ? `**Album:** ${track.album}${track.releaseYear ? ` (${track.releaseYear})` : ''}` : '',
    track.vibeReason ? `**Vibe:** ${track.vibeReason}` : `**Anchor:** ⚓ ${player.vibeAnchorArtist || track.artist}`,
    '',
    `\`${formatTime(elapsed)}\` ${bar} \`${track.formattedDuration}\``,
  ].filter(Boolean);

  if (player.deck2Track) {
    lines.push(`\n**Deck 2 (Ready):** ${player.deck2Track.artist} — *${player.deck2Track.title}*`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`🎶 ${track.title}`.slice(0, 250))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({
      text: `Mode: ${player.vibeMode.toUpperCase()} | Engine: ${player.vibeEngineSource.toUpperCase()} | Queue: ${player.queue.length} | Vol: ${player.broadcastTee.getVolumePercent()}%`,
    });

  if (track.artworkUrl && track.artworkUrl.startsWith('http')) {
    embed.setThumbnail(track.artworkUrl);
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('owr_pause_resume')
      .setLabel(player.isPaused ? 'Resume' : 'Pause')
      .setEmoji(player.isPaused ? '▶️' : '⏸️')
      .setStyle(player.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('owr_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('owr_like')
      .setLabel('Love Vibe')
      .setEmoji('👍')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_dislike')
      .setLabel('Skip & Cool')
      .setEmoji('👎')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}
