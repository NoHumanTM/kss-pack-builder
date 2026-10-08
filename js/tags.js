// KSS Pack Builder - lectura de etiquetas (ID3, MP4, FLAC) y agrupación en álbumes.

import { guessGenre, extOf, COVER_NAMES } from "./constants.js";

function readWithJsMediaTags(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve(null);
    window.jsmediatags.read(file, {
      onSuccess: (result) => resolve(result.tags || null),
      onError: () => resolve(null),
    });
  });
}

function folderOf(file) {
  const rel = file.webkitRelativePath || file.relativePath || "";
  const parts = rel.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function baseName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

// "03 - Artista - Título" / "Artista - Título" / "03. Título"
function parseFileName(name) {
  let s = baseName(name).replace(/_/g, " ").trim();
  let track = null;
  const num = /^(\d{1,3})[\s.\-)]+(.*)$/.exec(s);
  if (num) {
    track = parseInt(num[1], 10);
    s = num[2].trim();
  }
  let artist = null;
  let title = s;
  const dash = s.split(/\s+-\s+/);
  if (dash.length >= 2) {
    artist = dash[0].trim();
    title = dash.slice(1).join(" - ").trim();
  }
  // quita coletillas típicas de vídeos
  title = title.replace(/\s*[\(\[](official|oficial|lyrics?|letra|audio|video|vídeo|hd|hq|4k|remaster(ed)?)[^\)\]]*[\)\]]/gi, "").trim();
  return { track, artist, title: title || baseName(name) };
}

function pictureBlob(picture) {
  if (!picture || !picture.data) return null;
  const bytes = new Uint8Array(picture.data);
  return new Blob([bytes], { type: picture.format || "image/jpeg" });
}

// Lee la información de una pista. Devuelve { file, title, artist, album, year, track, disc, genre, picture }
export async function readTrackInfo(file) {
  const tags = await readWithJsMediaTags(file);
  const fromName = parseFileName(file.name);
  const info = {
    file,
    title: fromName.title,
    artist: fromName.artist,
    album: null,
    year: null,
    track: fromName.track,
    disc: 1,
    genre: null,
    picture: null,
    folder: folderOf(file),
  };
  if (tags) {
    if (tags.title) info.title = String(tags.title).trim();
    const albumArtist = tags.TPE2?.data || tags.aART?.data || tags.ALBUMARTIST?.data;
    if (albumArtist) info.albumArtist = String(albumArtist).trim();
    if (tags.artist) info.artist = String(tags.artist).trim();
    if (tags.album) info.album = String(tags.album).trim();
    if (tags.year) info.year = parseInt(String(tags.year).slice(0, 4), 10) || null;
    if (tags.track) info.track = parseInt(String(tags.track), 10) || info.track;
    const disc = tags.TPOS?.data || tags.disk?.data;
    if (disc) info.disc = parseInt(String(disc.disk ?? disc), 10) || 1;
    if (tags.genre) info.genre = guessGenre(tags.genre);
    info.picture = pictureBlob(tags.picture);
  }
  if (!info.genre) info.genre = guessGenre(info.folder);
  return info;
}

export function isCoverImage(file) {
  const ext = extOf(file.name);
  if (!["jpg", "jpeg", "png", "webp"].includes(ext)) return false;
  const base = baseName(file.name).toLowerCase();
  return COVER_NAMES.some((n) => base === n || base.startsWith(n));
}

// Clave de agrupación: álbum + artista del álbum (o carpeta si no hay etiquetas)
export function groupKey(info) {
  const album = (info.album || info.folder || "").toLowerCase();
  const artist = (info.albumArtist || (info.album ? info.artist : "") || "").toLowerCase();
  return `${album}|${artist}`;
}
