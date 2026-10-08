// KSS Pack Builder - genera los archivos de texto del pack.
// Debe producir lo mismo que tools/kss_pack.py (mismo formato, mismos nombres).

import { FORMAT_VERSION, CORE_MOD_ID, CLIP_DISTANCE_MIN, CLIP_DISTANCE_MAX } from "./constants.js";

export function luaStr(value) {
  const s = String(value ?? "")
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
  return `"${s}"`;
}

export const soundName = (packId, trackId) => `KSS_${packId}_${trackId}`;

export function modFolderName(packId) {
  return `KSS_Pack_${packId}`;
}

// Rutas dentro de la carpeta del mod
export function paths(packId) {
  return {
    sound: (trackId, muffled) => `common/media/sound/KSS/${packId}/${trackId}${muffled ? "_m" : ""}.ogg`,
    soundDir: `common/media/sound/KSS/${packId}`,
    cover: (albumId) => `common/media/textures/KSS/${packId}/${albumId}.png`,
    coverDir: `common/media/textures/KSS/${packId}`,
    modInfo: "42/mod.info",
    sounds: `42/media/scripts/KSS_${packId}_sounds.txt`,
    lua: `42/media/lua/shared/KSS_Pack_${packId}.lua`,
    manifest: "kss_pack.json",
    poster: "42/poster.png",
  };
}

function soundBlock(name, file) {
  return `    sound ${name}\n    {\n        category = Item,\n        clip\n        {\n`
    + `            file = ${file},\n`
    + `            distanceMin = ${CLIP_DISTANCE_MIN},\n            distanceMax = ${CLIP_DISTANCE_MAX},\n`
    + `            volume = 1.0,\n        }\n    }\n`;
}

export function soundsScript(pack) {
  const blocks = [];
  for (const album of pack.albums) {
    for (const track of album.tracks) {
      const name = soundName(pack.id, track.id);
      blocks.push(soundBlock(name, `media/sound/KSS/${pack.id}/${track.id}.ogg`));
      blocks.push(soundBlock(`${name}_m`, `media/sound/KSS/${pack.id}/${track.id}_m.ogg`));
    }
  }
  return "module Base\n{\n" + blocks.join("\n") + "}\n";
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function luaNumber(n) {
  const r = round2(n);
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function packLua(pack) {
  const albums = pack.albums.map((album) => {
    const tracks = album.tracks.map((t) => {
      const name = soundName(pack.id, t.id);
      return `                { id = ${luaStr(t.id)}, title = ${luaStr(t.title)}, `
        + `sound = ${luaStr(name)}, soundMuffled = ${luaStr(name + "_m")}, duration = ${luaNumber(t.duration)} },`;
    }).join("\n");
    const year = parseInt(album.year, 10);
    const cover = album.hasCover ? luaStr(`media/textures/KSS/${pack.id}/${album.id}.png`) : "nil";
    return "        {\n"
      + `            id = ${luaStr(album.id)},\n`
      + `            title = ${luaStr(album.title)},\n`
      + `            artist = ${luaStr(album.artist)},\n`
      + `            year = ${Number.isFinite(year) ? year : "nil"},\n`
      + `            genre = ${luaStr(album.genre)},\n`
      + `            rarity = ${luaStr(album.rarity)},\n`
      + `            formats = { ${album.formats.map(luaStr).join(", ")} },\n`
      + `            cover = ${cover},\n`
      + "            tracks = {\n" + tracks + "\n            },\n"
      + "        },";
  }).join("\n");
  return "-- Generado por KSS Pack Builder. No lo edites a mano: edita kss_pack.json y vuelve a generar.\n"
    + 'require "KSS/KSS_Core"\n\n'
    + "KSS.registerPack({\n"
    + `    id = ${luaStr(pack.id)},\n`
    + `    name = ${luaStr(pack.name || pack.id)},\n`
    + `    author = ${luaStr(pack.author || "")},\n`
    + `    formatVersion = ${FORMAT_VERSION},\n`
    + "    albums = {\n" + albums + "\n    },\n"
    + "})\n";
}

function oneLine(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").trim();
}

export function modInfo(pack) {
  const name = oneLine(pack.name || pack.id);
  return `name=KSS Pack: ${name}\n`
    + `id=${modFolderName(pack.id)}\n`
    + `require=\\${CORE_MOD_ID}\n`
    + `description=Pack de música para Knox Sound System. ${oneLine(pack.description)}\n`
    + `author=${oneLine(pack.author)}\n`
    + "poster=poster.png\n"
    + "versionMin=42.20.0\n";
}

// Manifiesto: la "fuente de verdad" para volver a abrir el pack y añadir canciones
export function manifest(pack) {
  return JSON.stringify({
    formatVersion: FORMAT_VERSION,
    id: pack.id,
    name: pack.name,
    author: pack.author,
    description: pack.description,
    albums: pack.albums.map((a) => ({
      id: a.id,
      title: a.title,
      artist: a.artist,
      year: parseInt(a.year, 10) || null,
      genre: a.genre,
      rarity: a.rarity,
      formats: a.formats,
      cover: a.hasCover ? `covers/${a.id}.png` : null,
      tracks: a.tracks.map((t) => ({ id: t.id, title: t.title, file: t.sourceName || null, duration: round2(t.duration) })),
    })),
  }, null, 2);
}

// previous: el workshop.txt que ya había (si se vuelve a generar). Se conservan el "id=" que pone el juego
// al subirlo (sin él, la próxima subida crearía otro objeto) y la visibilidad que haya elegido el usuario.
export function workshopTxt(pack, previous = "") {
  const keep = (key) => (previous.match(new RegExp(`^${key}=(.*)$`, "m")) || [])[1]?.trim();
  const id = keep("id");
  const visibility = keep("visibility") || "unlisted";
  const lines = [
    "version=1",
    ...(id ? [`id=${id}`] : []),
    `title=KSS Pack: ${oneLine(pack.name || pack.id)}`,
    `description=Music pack for Knox Sound System. ${oneLine(pack.description)}`,
    "description=",
    "description=Requires [url=https://steamcommunity.com/sharedfiles/filedetails/?id=3815623933]Knox Sound System[/url] (Workshop ID 3815623933).",
    "tags=Build 42;Audio",
    `visibility=${visibility}`,
  ];
  return lines.join("\n") + "\n";
}
