// KSS Pack Builder - constantes del formato de pack (deben coincidir con tools/kss_pack.py y el mod).

export const FORMAT_VERSION = 1;
export const CORE_MOD_ID = "KnoxSoundSystem";
export const PACK_ID_RE = /^[a-z0-9_]{3,32}$/;

export const GENRES = [
  "rock", "metal", "punk", "grunge", "pop", "hiphop", "country", "blues", "jazz",
  "soul", "electronic", "classical", "folk", "latin", "reggae", "gospel", "soundtrack", "other",
];
export const RARITIES = ["common", "uncommon", "rare", "collector"];
export const FORMATS = ["cd", "cassette"];

// Audio: mono (mejor para el sonido 3D del juego y pesa la mitad), volumen normalizado
export function audioArgs(normalize) {
  const args = ["-vn", "-ac", "1", "-ar", "44100"];
  if (normalize) args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
  return args.concat(["-c:a", "libvorbis", "-q:a", "3"]);
}
// Versión amortiguada (a través de paredes): solo graves; se hace a partir del .ogg ya convertido
export const MUFFLED_ARGS = ["-vn", "-ac", "1", "-ar", "22050", "-af", "lowpass=f=450,lowpass=f=450,volume=4dB",
  "-c:a", "libvorbis", "-q:a", "0"];

export const COVER_SIZE = 128;
export const PREVIEW_SIZE = 256;
export const CLIP_DISTANCE_MIN = 3;
export const CLIP_DISTANCE_MAX = 45;

export const AUDIO_EXT = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "oga", "opus", "wma", "aif", "aiff", "alac",
  "mp4", "m4v", "webm", "mkv", "mov"];
export const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
export const COVER_NAMES = ["cover", "folder", "front", "album", "albumart", "artwork"];

// Palabras de las etiquetas de género -> género del mod
export const GENRE_KEYWORDS = [
  ["grunge", "grunge"], ["punk", "punk"], ["metal", "metal"], ["hardcore", "punk"],
  ["hip hop", "hiphop"], ["hip-hop", "hiphop"], ["hiphop", "hiphop"], ["rap", "hiphop"], ["trap", "hiphop"],
  ["country", "country"], ["bluegrass", "country"], ["americana", "folk"],
  ["blues", "blues"], ["jazz", "jazz"], ["swing", "jazz"],
  ["soul", "soul"], ["r&b", "soul"], ["rnb", "soul"], ["funk", "soul"], ["motown", "soul"], ["disco", "soul"],
  ["electro", "electronic"], ["techno", "electronic"], ["house", "electronic"], ["trance", "electronic"],
  ["edm", "electronic"], ["dance", "electronic"], ["synth", "electronic"], ["ambient", "electronic"],
  ["drum", "electronic"], ["dubstep", "electronic"], ["industrial", "electronic"],
  ["classical", "classical"], ["clásica", "classical"], ["orchestra", "classical"], ["opera", "classical"],
  ["folk", "folk"], ["acoustic", "folk"], ["singer", "folk"],
  ["latin", "latin"], ["latino", "latin"], ["reggaeton", "latin"], ["salsa", "latin"], ["cumbia", "latin"],
  ["bachata", "latin"], ["merengue", "latin"], ["flamenco", "latin"], ["bolero", "latin"], ["ranchera", "latin"],
  ["reggae", "reggae"], ["ska", "reggae"], ["dub", "reggae"],
  ["gospel", "gospel"], ["christian", "gospel"], ["worship", "gospel"],
  ["soundtrack", "soundtrack"], ["score", "soundtrack"], ["ost", "soundtrack"], ["film", "soundtrack"], ["game", "soundtrack"],
  ["pop", "pop"], ["rock", "rock"], ["alternative", "rock"], ["indie", "rock"],
];

export function guessGenre(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const [word, genre] of GENRE_KEYWORDS) {
    if (t.includes(word)) return genre;
  }
  return null;
}

export function newId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function slugify(text) {
  const s = String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, 32) || "mipack";
}

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
