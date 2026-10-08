// KSS Pack Builder - ayuda para traer música de YouTube con yt-dlp.
// Una web no puede descargar de YouTube por sí misma: aquí se genera el comando de yt-dlp para que
// el usuario lo ejecute en su PC. Las playlists salen como un álbum (carpeta = nombre de la playlist,
// número de pista = posición en la playlist), con título, artista y miniatura como carátula.

// Acepta enlaces con o sin https://, con texto alrededor, youtu.be, Shorts, directos e incrustados
export function parseYouTubeUrl(text) {
  const found = /((?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be)\/[^\s"'<>]*)/i.exec(String(text || ""));
  if (!found) return null;
  let raw = found[1];
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (!["youtube.com", "youtu.be"].includes(host)) return null;
  const list = url.searchParams.get("list");
  let video = url.searchParams.get("v");
  const path = /^\/(shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
  if (path) video = path[2];
  if (host === "youtu.be") video = url.pathname.slice(1).split("/")[0] || null;
  if (!list && !video) return null;
  return {
    url: url.href,
    isPlaylist: !!list && (!video || url.pathname.startsWith("/playlist")),
    hasPlaylist: !!list,
    hasVideo: !!video,
    music: url.hostname.startsWith("music."),
  };
}

function quote(s, shell) {
  // PowerShell y bash aceptan comillas dobles; dentro de PowerShell el % no se expande
  return shell === "powershell" ? `"${s.replace(/"/g, '`"')}"` : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

// mode: "playlist" (toda la lista como álbum) | "video" (solo este vídeo)
export function buildCommand(info, mode, shell = "powershell") {
  const playlist = mode === "playlist";
  const out = playlist
    ? "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s"
    : "Singles/%(title)s.%(ext)s";
  const parts = [
    "yt-dlp",
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg",
    "--ppa", quote("ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop=ih:ih", shell),
  ];
  if (playlist) {
    parts.push("--yes-playlist",
      "--parse-metadata", quote("playlist_title:%(album)s", shell),
      "--parse-metadata", quote("playlist_index:%(track_number)s", shell));
  } else {
    parts.push("--no-playlist");
  }
  parts.push("-o", quote(out, shell), quote(info.url, shell));
  return parts.join(" ");
}

export const INSTALL = {
  windows: "winget install yt-dlp",
  mac: "brew install yt-dlp ffmpeg",
  linux: "pipx install yt-dlp   (y ffmpeg desde tu gestor de paquetes)",
};
