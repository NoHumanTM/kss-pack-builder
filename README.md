# KSS Pack Builder

Create music packs for **Knox Sound System**, a Project Zomboid (Build 42) mod that adds CDs, cassettes,
Walkboxes, Boomboxes and car stereos with real music.

**➜ Use it online:** https://nohumantm.github.io/kss-pack-builder/

Everything runs in your browser: your songs are converted with ffmpeg compiled to WebAssembly and are
**never uploaded anywhere**.

## Features
- Drop music files or whole folders: mp3, flac, wav, m4a, ogg, opus, even videos.
- Reads tags and cover art and groups tracks into albums automatically.
- Edit everything: cover, title, artist, year, genre, rarity, formats (CD / cassette), track order.
- **YouTube videos and playlists:** generates the `yt-dlp` command for you (a playlist becomes an album).
- Converts to what the game needs: mono Ogg Vorbis, volume normalization, and a muffled version used
  when music plays behind walls.
- Saves straight into `Zomboid/mods` or ready to upload to the Steam Workshop (Chrome / Edge), or as a `.zip`
  (any browser).
- Re-open a pack later to add songs without breaking saved games.
- English / Español.

## Run it locally
It must be served over HTTP (not opened as a file):

```bash
python -m http.server 8642
```

Then open `http://localhost:8642/`.

## Pack format
See `docs/FORMATO_PACK.md` in the Knox Sound System repository. This tool and `tools/kss_pack.py`
produce the same output.

## License
GPL-3.0 (because it bundles ffmpeg.wasm). See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
Only use music you have the right to use.
