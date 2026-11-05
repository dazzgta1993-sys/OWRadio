# ⚡ OWRadio Studio v3.0 — 100% Real Multi-Cloud 24/7 Web Radio & Discord Audio Engine

> A high-fidelity, zero-fake 24/7 internet radio station and Discord music bot powered by **YouTube Music (`WEB_REMIX`)**, **Deezer Studio**, **MusicBrainz**, **Apple Music / iTunes**, **Spotify**, and **YouTube Basic (`yt-dlp`)**.
> Every source file in `src/` is strictly modularized under **300 lines of code**.

---

## 🌟 Core Architecture

- **🎵 6-Pass Studio Audio Resolver:** Queries **YouTube Music's `WEB_REMIX` Studio Songs filter** first (`+50` official `- Topic` / `ATV` bonus, `-60` UGC penalty) and enforces a strict **`±5s` duration guardrail** against Deezer's canonical studio duration so music video skits, sped-up edits, and fan uploads are rejected automatically.
- **🌐 6 Real Music Databases Working Together:**
  1. **YouTube Music (`WEB_REMIX`):** Official label `- Topic` studio masters & Song-Exact Up Next Radio.
  2. **Deezer Studio API:** Canonical track durations, `ISRC` recording codes, `UPC` barcodes, Artist Radio & Related Artists (`nb_fan >= 3,000`).
  3. **MusicBrainz API:** Strict Studio Album Gate (`primary-type == 'Album'` with zero compilation/live/soundtrack secondary types).
  4. **Apple Music / iTunes:** `1400×1400` HD album artwork via `UPC` barcode lookup + Official UK Top 40 & US Hot 100 charts.
  5. **Spotify Zero-Key Resolver:** Resolves Spotify tracks, albums, and playlists via `/embed/` + `oEmbed` + Deezer duration enrichment.
  6. **YouTube Basic (`yt-dlp`):** Direct live concert, remix, and video link streaming when requested.
- **⚡ Triple-Deck Pre-Warming Engine:**
  - **Deck 1:** Now Playing (48kHz 16-bit stereo PCM simultaneously feeding Discord Voice & 192kbps `/stream.mp3`).
  - **Deck 2:** Next Up (Pre-warmed stream URL & 1400px studio cover ready in advance for `<50ms` transitions).
  - **Deck 3:** In The Chute (Lookahead standby).
- **⚓ Song-Exact Vibe Anchor & Collaboration Splitter:** Locks onto the exact song and artist you play, splits multi-artist collaborations (including `(feat. ...)` in titles) for 4-track artist separation, and instantly purges old Autoplay tracks the moment you pick a new song.

---

## 🚀 Quick Start

```bash
git clone https://github.com/dazzgta1993-sys/OWRadio.git
cd OWRadio
npm install
cp .env.example .env
npm run dev
```

- **Web Studio Dashboard:** [http://localhost:8091](http://localhost:8091)
- **Live 192kbps MP3 Stream:** [http://localhost:8091/stream.mp3](http://localhost:8091/stream.mp3)

---

## 💬 Discord Studio Slash Commands (11 Commands)

| Command | Description |
| :--- | :--- |
| **`/play <query> [source] [mode]`** | Play Now (locks Vibe Anchor) or Add to Queue using `🌐 Auto`, `🔴 YouTube Music`, `🟣 Deezer Studio`, `🍎 Apple Music`, or `▶️ YouTube Live/Video` |
| **`/nowplaying`** | Posts the live interactive **Studio Player Card** showing Deck 1, Deck 2, Deck 3, and **8 control buttons** (`Pause/Resume`, `Skip`, `Stop`, `Lock Vibe`, `Skip & Cool`, `Shuffle Decks`, `Loop`, `Autoplay ON/OFF`) |
| **`/queue`** | View Deck 1, Deck 2 (Ready), Deck 3 (Cued), and the upcoming Queue |
| **`/charts <country>`** | Load & play the **🇬🇧 UK Top 40**, **🇺🇸 US Hot 100**, or **🌍 Global Deezer Top** |
| **`/discography <artist>`** | Explore an artist's **MusicBrainz Canonical Studio Albums** with release years |
| **`/vibe [mode] [engine] [autoplay]`** | Configure Vibe Mode (`balanced`, `deep_dive`, `collabs`, `discovery`), Source (`auto`, `deezer`, `ytmusic`, `musicbrainz`, `apple`, `charts`), or Autoplay |
| **`/skip`** | Instantly transition to the pre-warmed track on Deck 2 |
| **`/pause` • `/resume` • `/stop`** | Pause, resume, or stop broadcast and clear the queue |
| **`/volume <0-200>`** | Adjust broadcast and Discord voice gain (`0%–200%`) |

---

## 🐳 Docker Deployment

`OWRADIO-DOCKER/` contains a complete, self-contained Docker mirror of `src/`:

```bash
cd OWRADIO-DOCKER
cp .env.example .env
docker compose up -d --build
```

---

## 📄 License

Distributed under the [MIT License](./package.json).
