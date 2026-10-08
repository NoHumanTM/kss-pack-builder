// KSS Pack Builder - aplicación principal.

import { t, tHtml, applyStatic, getLang, setLang } from "./i18n.js";
import {
  GENRES, RARITIES, FORMATS, PACK_ID_RE, AUDIO_EXT, IMAGE_EXT, MAX_TRACKS, MOD_URL,
  newId, slugify, extOf, formatTime,
} from "./constants.js";
import { readTrackInfo, isCoverImage, groupKey } from "./tags.js";
import { loadFFmpeg, convertTrack, squareImage, makePreview } from "./convert.js";
import * as gen from "./packgen.js";
import { canWriteFolders, ZipWriter, SubWriter, pickZomboidFolder, pickPackFolder } from "./output.js";
import { parseYouTubeUrl, buildCommand } from "./youtube.js";

const $ = (id) => document.getElementById(id);
const STEPS = ["pack", "music", "albums", "build"];

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const state = {
  pack: { id: "", name: "", author: "", description: "", albums: [] },
  idTouched: false,
  opened: null,     // { writer, label } si se abrió un pack existente o ya se generó en una carpeta
  dirty: false,
  building: false,
  built: false,
  cancel: false,
  step: "pack",
  view: "home",
};

function newAlbum(fields = {}) {
  return {
    id: newId(),
    title: "",
    artist: "",
    year: "",
    genre: null,
    rarity: "common",
    formats: ["cd", "cassette"],
    coverBlob: null,
    coverUrl: null,
    tracks: [],
    open: undefined,  // tarjeta desplegada en el paso 3 (undefined = decide la app)
    ...fields,
  };
}

function setCover(album, blob) {
  if (album.coverUrl) URL.revokeObjectURL(album.coverUrl);
  album.coverBlob = blob;
  album.coverUrl = blob ? URL.createObjectURL(blob) : null;
}

function markDirty() {
  state.dirty = true;
  state.built = false;
}

function allTracks() {
  return state.pack.albums.flatMap((a) => a.tracks);
}

// ---------------------------------------------------------------------------
// Utilidades de interfaz
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function icon(name, size = "sm") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `ic ${size}`);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function select(options, value, onChange, placeholder) {
  const s = el("select", { onchange: (e) => onChange(e.target.value) });
  if (placeholder) s.append(el("option", { value: "", text: placeholder }));
  for (const [v, label] of options) {
    const o = el("option", { value: v, text: label });
    if (v === value) o.selected = true;
    s.append(o);
  }
  return s;
}

function notice(id, text) {
  const node = $(id);
  node.textContent = text;
  node.hidden = !text;
}

let toastTimer = null;
function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Estado de cada paso
// ---------------------------------------------------------------------------
function packOk() {
  return !!state.pack.name.trim() && PACK_ID_RE.test(state.pack.id);
}

function badAlbums() {
  return state.pack.albums.filter((a) => albumWarnings(a).length);
}

function stepDone(step) {
  if (step === "pack") return packOk();
  if (step === "music") return allTracks().length > 0;
  if (step === "albums") return allTracks().length > 0 && badAlbums().length === 0;
  if (step === "build") return state.built;
  return false;
}

function refreshChrome() {
  document.querySelectorAll("#steps button").forEach((b) => {
    b.classList.toggle("active", b.dataset.step === state.step);
    b.classList.toggle("done", b.dataset.step !== state.step && stepDone(b.dataset.step));
  });
  const i = STEPS.indexOf(state.step);
  $("nav-back").style.visibility = i > 0 ? "visible" : "hidden";
  $("nav-next").hidden = state.step === "build";
  const tracks = allTracks().length;
  const albums = state.pack.albums.length;
  let info = "";
  if (state.step === "pack") info = packOk() ? tHtml("bar.packOk", state.pack.name) : t("bar.packMissing");
  if (state.step === "music") info = tracks ? tHtml("bar.musicOk", tracks, albums) : t("bar.musicMissing");
  if (state.step === "albums") {
    const bad = badAlbums().length;
    info = !tracks ? t("bar.musicMissing") : bad ? tHtml("bar.albumsBad", bad) : tHtml("bar.albumsOk", albums);
  }
  if (state.step === "build") info = tHtml("bar.build", tracks, albums);
  $("actionbar-info").innerHTML = info;
  $("nav-next").disabled = (state.step === "pack" && !packOk()) || (state.step === "music" && !tracks);
}

// ---------------------------------------------------------------------------
// Vistas: portada y asistente
// ---------------------------------------------------------------------------
function showHome(anchor) {
  state.view = "home";
  $("home").hidden = false;
  $("wizard").hidden = true;
  if (anchor) $(anchor).scrollIntoView({ behavior: "smooth" });
  else window.scrollTo({ top: 0 });
}

function showWizard(step = state.step) {
  state.view = "wizard";
  $("home").hidden = true;
  $("wizard").hidden = false;
  showStep(step);
}

function showStep(step) {
  state.step = step;
  for (const s of STEPS) $(`step-${s}`).hidden = s !== step;
  if (step === "music") renderAdded();
  if (step === "albums") renderAlbums();
  if (step === "build") renderBuild();
  refreshChrome();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goNext() {
  if (state.step === "albums") {
    const bad = badAlbums();
    if (bad.length) {
      bad[0].open = true;
      renderAlbums();
      document.querySelector(".album.has-warnings")?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast(t("build.fixAlbums"));
      return;
    }
  }
  const i = STEPS.indexOf(state.step);
  if (i < STEPS.length - 1) showStep(STEPS[i + 1]);
}

function goBack() {
  const i = STEPS.indexOf(state.step);
  if (i > 0) showStep(STEPS[i - 1]);
}

// ---------------------------------------------------------------------------
// Paso 1: pack
// ---------------------------------------------------------------------------
function syncPackForm() {
  $("pack-name").value = state.pack.name;
  $("pack-id").value = state.pack.id;
  $("pack-author").value = state.pack.author;
  $("pack-desc").value = state.pack.description;
  validatePackId();
}

function validatePackId() {
  const ok = PACK_ID_RE.test(state.pack.id);
  $("pack-id").classList.toggle("invalid", !ok && !!state.pack.name);
  $("pack-id-preview").textContent = state.pack.id || "—";
  if (!ok && state.idTouched) $("pack-advanced").open = true;
  return ok;
}

function resetPack() {
  for (const a of state.pack.albums) setCover(a, null);
  state.pack = { id: "", name: "", author: "", description: "", albums: [] };
  state.idTouched = false;
  state.opened = null;
  state.dirty = false;
  state.built = false;
  notice("pack-notice", "");
  $("next-steps").hidden = true;
  $("progress").hidden = true;
  $("log").replaceChildren();
  syncPackForm();
  refreshChrome();
}

async function openExistingPack() {
  try {
    const { writer, manifest, label } = await pickPackFolder();
    resetPack();
    state.pack.id = manifest.id;
    state.pack.name = manifest.name || manifest.id;
    state.pack.author = manifest.author || "";
    state.pack.description = manifest.description || "";
    state.idTouched = true;
    for (const a of manifest.albums || []) {
      const album = newAlbum({
        id: a.id, title: a.title || "", artist: a.artist || "", year: a.year || "",
        genre: a.genre || null, rarity: a.rarity || "common", formats: a.formats || ["cd", "cassette"],
      });
      album.tracks = (a.tracks || []).map((tr) => ({
        id: tr.id, title: tr.title, file: null, existing: true, duration: tr.duration || 0, sourceName: tr.file || null,
      }));
      try {
        setCover(album, await writer.read(gen.paths(manifest.id).cover(a.id)));
      } catch (e) { /* sin carátula */ }
      state.pack.albums.push(album);
    }
    state.opened = { writer, label };
    syncPackForm();
    notice("pack-notice", t("pack.opened", state.pack.name, state.pack.albums.length));
    refreshChrome();
  } catch (e) {
    if (e.name !== "AbortError") notice("pack-notice", String(e.message || e));
  }
}

// ---------------------------------------------------------------------------
// Paso 2: música
// ---------------------------------------------------------------------------
async function readEntry(entry, path, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    Object.defineProperty(file, "relativePath", { value: path + file.name });
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await readEntry(child, `${path}${entry.name}/`, out);
    } while (batch.length > 0);
  }
}

async function filesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return Array.from(dataTransfer.files || []);
  const out = [];
  for (const entry of entries) await readEntry(entry, "", out);
  return out;
}

function folderPath(file) {
  const rel = file.webkitRelativePath || file.relativePath || file.name;
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

function readingProgress(done, total) {
  $("reading").hidden = done >= total;
  $("reading-fill").style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
  $("reading-text").textContent = t("music.reading", done, total);
}

async function addFiles(files) {
  const audio = files.filter((f) => AUDIO_EXT.includes(extOf(f.name)));
  const covers = new Map(); // carpeta -> imagen de carátula
  for (const f of files) {
    if (IMAGE_EXT.includes(extOf(f.name)) && isCoverImage(f)) covers.set(folderPath(f), f);
  }
  if (!audio.length) return;

  const groups = new Map();
  for (let i = 0; i < audio.length; i++) {
    readingProgress(i, audio.length);
    const info = await readTrackInfo(audio[i]);
    const key = groupKey(info);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(info);
  }
  readingProgress(audio.length, audio.length);

  let added = 0;
  let albumsTouched = 0;
  for (const infos of groups.values()) {
    infos.sort((a, b) => (a.disc - b.disc) || ((a.track ?? 999) - (b.track ?? 999)) || a.title.localeCompare(b.title));
    const first = infos[0];
    const title = first.album || first.folder || "Singles";
    const artist = first.albumArtist || first.artist || "";
    let album = state.pack.albums.find((a) => a.title.toLowerCase() === title.toLowerCase()
      && a.artist.toLowerCase() === artist.toLowerCase());
    if (!album) {
      album = newAlbum({ title, artist, year: first.year || "", genre: infos.find((x) => x.genre)?.genre || null });
      state.pack.albums.push(album);
    }
    albumsTouched++;
    if (!album.coverBlob) {
      const pic = infos.find((x) => x.picture)?.picture || covers.get(folderPath(first.file));
      if (pic) setCover(album, pic);
    }
    for (const info of infos) {
      // un álbum de varios artistas: muestra el artista en el título de la pista
      const various = album.artist && info.artist && info.artist.toLowerCase() !== album.artist.toLowerCase();
      album.tracks.push({
        id: newId(),
        title: various ? `${info.artist} - ${info.title}` : info.title,
        file: info.file,
        existing: false,
        duration: 0,
        sourceName: info.file.name,
      });
      added++;
    }
  }
  splitOversizedAlbums();
  markDirty();
  toast(t("music.added", added, albumsTouched));
  renderAdded();
  refreshChrome();
}

function renderAdded() {
  const albums = state.pack.albums.filter((a) => a.tracks.length);
  $("added").hidden = !albums.length;
  $("added-list").replaceChildren(...albums.map((a) => {
    const thumb = el("span", { class: "thumb" }, a.coverUrl ? [] : [icon("disc")]);
    if (a.coverUrl) thumb.style.backgroundImage = `url("${a.coverUrl}")`;
    return el("li", {}, [thumb, el("span", { class: "meta" }, [
      el("b", { text: a.title || "?" }),
      el("small", { text: [a.artist, t("album.tracks", a.tracks.length)].filter(Boolean).join(" · ") }),
    ])]);
  }));
}

// Un CD o un cassette lleva como mucho MAX_TRACKS pistas: los álbumes más grandes se parten en volúmenes.
// El primer volumen conserva el álbum (y su id, para no romper partidas); los demás son álbumes nuevos.
const VOL_RE = /\s*\(Vol\.\s*(\d+)\)\s*$/i;

function splitAlbum(album) {
  if (album.tracks.length <= MAX_TRACKS) return [album];
  const base = album.title.replace(VOL_RE, "").trim() || album.title;
  const alreadyVolume = VOL_RE.test(album.title);
  // si ya era un volumen, los trozos nuevos siguen la numeración de los volúmenes que existan
  let nextVol = 1;
  if (alreadyVolume) {
    for (const a of state.pack.albums) {
      const m = VOL_RE.exec(a.title);
      if (m && a.title.replace(VOL_RE, "").trim().toLowerCase() === base.toLowerCase()) {
        nextVol = Math.max(nextVol, parseInt(m[1], 10) + 1);
      }
    }
  }
  const chunks = [];
  for (let i = 0; i < album.tracks.length; i += MAX_TRACKS) chunks.push(album.tracks.slice(i, i + MAX_TRACKS));
  return chunks.map((tracks, i) => {
    const vol = i === 0 ? album : newAlbum({
      artist: album.artist, year: album.year, genre: album.genre, rarity: album.rarity, formats: [...album.formats],
    });
    if (!alreadyVolume) vol.title = `${base} (Vol. ${i + 1})`;
    else if (i > 0) vol.title = `${base} (Vol. ${nextVol++})`;
    vol.tracks = tracks;
    if (i > 0 && album.coverBlob) setCover(vol, album.coverBlob);
    return vol;
  });
}

function splitOversizedAlbums() {
  state.pack.albums = state.pack.albums.flatMap(splitAlbum);
}

function setupDropzone() {
  const zone = $("dropzone");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    await addFiles(await filesFromDrop(e.dataTransfer));
  });
  $("files-input").addEventListener("change", async (e) => { await addFiles(Array.from(e.target.files)); e.target.value = ""; });
  $("folder-input").addEventListener("change", async (e) => { await addFiles(Array.from(e.target.files)); e.target.value = ""; });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  }));
}

let lastYouTubeUrl = null;

function setupYouTube() {
  const update = () => {
    const info = parseYouTubeUrl($("yt-url").value);
    const text = $("yt-url").value.trim();
    $("yt-invalid").hidden = !text || !!info;
    $("yt-options").hidden = !info;
    $("yt-command-box").hidden = !info;
    if (!info) return;
    const radios = document.querySelectorAll("input[name=yt-mode]");
    radios[0].disabled = !info.hasPlaylist;
    radios[1].disabled = !info.hasVideo;
    if (info.url !== lastYouTubeUrl) {
      // enlace nuevo: por defecto toda la playlist si la hay
      lastYouTubeUrl = info.url;
      radios[info.hasPlaylist ? 0 : 1].checked = true;
    }
    if (!info.hasPlaylist) radios[1].checked = true;
    if (!info.hasVideo) radios[0].checked = true;
    const mode = document.querySelector("input[name=yt-mode]:checked").value;
    $("yt-command").textContent = buildCommand(info, mode, $("yt-shell").value);
  };
  // se actualiza al escribir, pegar, soltar una tecla, salir del campo o pulsar el botón / Enter
  for (const ev of ["input", "change", "keyup", "blur"]) $("yt-url").addEventListener(ev, update);
  $("yt-url").addEventListener("paste", () => setTimeout(update, 0));
  $("yt-url").addEventListener("keydown", (e) => { if (e.key === "Enter") update(); });
  $("yt-go").addEventListener("click", () => {
    update();
    if (!$("yt-command-box").hidden) $("yt-command-box").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.querySelectorAll("input[name=yt-mode]").forEach((r) => r.addEventListener("change", update));
  $("yt-shell").addEventListener("change", update);
  if (/mac|linux/i.test(navigator.platform)) $("yt-shell").value = "bash";
  $("yt-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("yt-command").textContent);
      toast(t("yt.copied"));
    } catch (e) { /* sin portapapeles */ }
  });
}

// ---------------------------------------------------------------------------
// Paso 3: álbumes
// ---------------------------------------------------------------------------
function albumWarnings(album) {
  const w = [];
  if (!album.title.trim()) w.push(t("warn.title"));
  if (!album.artist.trim()) w.push(t("warn.artist"));
  if (!album.genre) w.push(t("warn.genre"));
  if (!album.formats.length) w.push(t("warn.formats"));
  if (!album.tracks.length) w.push(t("warn.tracks"));
  if (album.tracks.length > MAX_TRACKS) w.push(t("warn.tooMany", album.tracks.length, MAX_TRACKS));
  return w;
}

let dragged = null; // { album, track }

function renderTrack(album, track, index) {
  const others = state.pack.albums.filter((a) => a !== album);
  const row = el("li", { class: "track", draggable: "true" });
  row.addEventListener("dragstart", (e) => {
    dragged = { album, track };
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => { row.classList.remove("dragging"); dragged = null; });
  row.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    row.classList.add("drop-before");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-before");
    if (!dragged) return;
    const from = dragged.album.tracks.indexOf(dragged.track);
    dragged.album.tracks.splice(from, 1);
    const to = album.tracks.indexOf(track);
    album.tracks.splice(to < 0 ? album.tracks.length : to, 0, dragged.track);
    markDirty();
    renderAlbums();
  });

  const move = select(
    [...others.map((a, i) => [String(i), a.title || "?"]), ["new", t("track.new")]],
    null,
    (v) => {
      if (!v) return;
      album.tracks.splice(album.tracks.indexOf(track), 1);
      let target;
      if (v === "new") {
        target = newAlbum({ title: track.title, artist: album.artist, genre: album.genre, formats: [...album.formats], open: true });
        state.pack.albums.push(target);
      } else {
        target = others[+v];
      }
      target.tracks.push(track);
      markDirty();
      renderAlbums();
    },
    t("track.moveTo"),
  );

  row.append(
    el("span", { class: "handle", text: "⠿", title: "drag" }),
    el("span", { class: "num", text: String(index + 1).padStart(2, "0") }),
    el("input", { type: "text", value: track.title, "aria-label": t("album.title"), oninput: (e) => { track.title = e.target.value; markDirty(); } }),
    el("span", { class: "dur", text: track.existing ? `${formatTime(track.duration)} · ${t("track.kept")}` : (track.duration ? formatTime(track.duration) : "") }),
    move,
    el("button", {
      class: "remove", type: "button", title: t("track.remove"), "aria-label": t("track.remove"), text: "×",
      onclick: () => { album.tracks.splice(album.tracks.indexOf(track), 1); markDirty(); renderAlbums(); },
    }),
  );
  return row;
}

function renderAlbumBody(album, warnings) {
  // carátula
  const coverInput = el("input", { type: "file", accept: "image/*", hidden: true });
  const cover = el("div", { class: "cover" + (album.coverUrl ? " has-img" : ""), title: t("album.cover"), tabindex: "0", role: "button" }, [
    icon("image", "lg"),
    el("span", { text: album.coverUrl ? t("album.coverChange") : t("album.coverAdd") }),
  ]);
  if (album.coverUrl) cover.style.backgroundImage = `url("${album.coverUrl}")`;
  cover.addEventListener("click", () => coverInput.click());
  cover.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); coverInput.click(); } });
  coverInput.addEventListener("change", () => {
    if (coverInput.files[0]) { setCover(album, coverInput.files[0]); markDirty(); renderAlbums(); }
  });
  cover.addEventListener("dragover", (e) => { if (!dragged) { e.preventDefault(); cover.classList.add("over"); } });
  cover.addEventListener("dragleave", () => cover.classList.remove("over"));
  cover.addEventListener("drop", (e) => {
    if (dragged) return;
    e.preventDefault();
    e.stopPropagation();
    cover.classList.remove("over");
    const img = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (img) { setCover(album, img); markDirty(); renderAlbums(); }
  });

  // campos (se re-pinta al salir del campo para actualizar avisos y cabecera)
  const input = (key, attrs = {}) => el("input", {
    type: "text", value: album[key] ?? "", ...attrs,
    oninput: (e) => { album[key] = e.target.value; markDirty(); },
    onchange: () => renderAlbums(),
  });
  const field = (label, control, missing, help) => el("label", { class: "field" + (missing ? " missing" : "") }, [
    el("span", { class: "label", text: label }), control, help ? el("small", { class: "help", text: help }) : null,
  ]);
  const genreSelect = select(GENRES.map((g) => [g, t(`genre.${g}`)]), album.genre,
    (v) => { album.genre = v || null; markDirty(); renderAlbums(); }, t("album.genrePick"));
  const raritySelect = select(RARITIES.map((r) => [r, t(`rarity.${r}`)]), album.rarity,
    (v) => { album.rarity = v; markDirty(); });
  const formats = el("div", { class: "formats" }, FORMATS.map((f) => el("label", {}, [
    el("input", {
      type: "checkbox", checked: album.formats.includes(f),
      onchange: (e) => {
        album.formats = e.target.checked ? [...new Set([...album.formats, f])] : album.formats.filter((x) => x !== f);
        markDirty();
        renderAlbums();
      },
    }),
    icon(f === "cd" ? "disc" : "tape", "xs"),
    t(`format.${f}`),
  ])));

  const othersWithoutGenre = album.genre && state.pack.albums.some((a) => a !== album && !a.genre);
  const side = el("div", { class: "album-side" }, [
    warnings.length ? el("div", { class: "warnings" }, warnings.map((w) => el("span", {}, [icon("alert", "xs"), w]))) : null,
    el("div", { class: "album-fields" }, [
      field(t("album.title"), input("title"), !album.title.trim()),
      field(t("album.artist"), input("artist"), !album.artist.trim()),
      field(t("album.year"), input("year", { inputmode: "numeric", maxlength: 4 })),
    ]),
    el("div", { class: "album-fields2" }, [
      field(t("album.genre"), genreSelect, !album.genre),
      field(t("album.rarity"), raritySelect),
      field(t("album.formats"), formats, !album.formats.length),
    ]),
    el("small", { class: "help", text: t("album.genreHelp") }),
    el("ol", { class: "tracks" }, album.tracks.map((tr, i) => renderTrack(album, tr, i))),
    el("div", { class: "album-actions" }, [
      el("span", {}, [
        othersWithoutGenre ? el("button", {
          class: "link", type: "button", text: t("album.applyGenre"),
          onclick: () => { for (const a of state.pack.albums) if (!a.genre) a.genre = album.genre; markDirty(); renderAlbums(); },
        }) : null,
      ]),
      el("span", { class: "actions-row" }, [
        album.tracks.length > MAX_TRACKS ? el("button", {
          class: "btn small", type: "button", text: t("album.split"),
          onclick: () => { splitOversizedAlbums(); markDirty(); renderAlbums(); },
        }) : null,
        el("button", {
          class: "btn small danger", type: "button",
          onclick: () => {
            if (!confirm(t("album.deleteConfirm", album.title, album.tracks.length))) return;
            setCover(album, null);
            state.pack.albums.splice(state.pack.albums.indexOf(album), 1);
            markDirty();
            renderAlbums();
          },
        }, [icon("trash", "xs"), t("album.delete")]),
      ]),
    ]),
  ]);
  return el("div", { class: "album-body" }, [el("div", {}, [cover, coverInput]), side]);
}

function renderAlbum(album) {
  const warnings = albumWarnings(album);
  if (album.open === undefined) album.open = state.pack.albums.length <= 2;
  const card = el("article", { class: "album" + (warnings.length ? " has-warnings" : "") + (album.open ? " open" : "") });

  const thumb = el("span", { class: "album-thumb" }, album.coverUrl ? [] : [icon("disc")]);
  if (album.coverUrl) thumb.style.backgroundImage = `url("${album.coverUrl}")`;
  const head = el("div", { class: "album-head", tabindex: "0", role: "button", "aria-expanded": String(album.open) }, [
    el("span", { class: "chev" }, [icon("chevron")]),
    thumb,
    el("span", { class: "album-title" }, [
      el("b", { text: album.title || "—" }),
      el("small", { text: [album.artist, album.genre ? t(`genre.${album.genre}`) : null, t("album.tracks", album.tracks.length)].filter(Boolean).join(" · ") }),
    ]),
    warnings.length
      ? el("span", { class: "status bad" }, [icon("alert", "xs"), t("status.bad", warnings.length)])
      : el("span", { class: "status ok" }, [icon("check", "xs"), t("status.ok")]),
  ]);
  const toggle = () => { album.open = !album.open; renderAlbums(); };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  card.append(head);
  if (album.open) card.append(renderAlbumBody(album, warnings));

  // soltar una pista al final de este álbum
  card.addEventListener("dragover", (e) => { if (dragged) { e.preventDefault(); card.classList.add("drop-target"); } });
  card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
  card.addEventListener("drop", (e) => {
    card.classList.remove("drop-target");
    if (!dragged) return;
    e.preventDefault();
    dragged.album.tracks.splice(dragged.album.tracks.indexOf(dragged.track), 1);
    album.tracks.push(dragged.track);
    markDirty();
    renderAlbums();
  });
  return card;
}

// Junta todas las pistas de todos los álbumes en un único álbum "Mix"
function mergeAllAlbums() {
  const albums = state.pack.albums;
  if (albums.length < 2) return;
  const total = albums.reduce((n, a) => n + a.tracks.length, 0);
  if (!confirm(t("albums.mergeConfirm", albums.length, total))) return;

  const genreCount = new Map();
  for (const a of albums) if (a.genre) genreCount.set(a.genre, (genreCount.get(a.genre) || 0) + a.tracks.length);
  const genre = [...genreCount.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const withCover = albums.find((a) => a.coverBlob);

  const mix = newAlbum({
    title: t("albums.mixTitle"),
    artist: t("albums.mixArtist"),
    genre,
    formats: [...new Set(albums.flatMap((a) => a.formats))],
    open: true,
  });
  if (withCover) setCover(mix, withCover.coverBlob);
  for (const a of albums) {
    for (const track of a.tracks) {
      // conserva el artista en el título si no está ya
      const artist = a.artist && a.artist.trim();
      if (artist && !track.title.toLowerCase().startsWith(artist.toLowerCase())) {
        track.title = `${artist} - ${track.title}`;
      }
      mix.tracks.push(track);
    }
    if (a !== withCover) setCover(a, null);
  }
  state.pack.albums = splitAlbum(mix);
  markDirty();
  renderAlbums();
}

function renderBulkGenre() {
  const missing = state.pack.albums.filter((a) => !a.genre);
  $("bulk").hidden = missing.length < 2;
  if (missing.length < 2) return;
  $("bulk-text").textContent = t("bulk.text", missing.length);
  const s = $("bulk-genre");
  s.replaceChildren(el("option", { value: "", text: t("bulk.pick") }), ...GENRES.map((g) => el("option", { value: g, text: t(`genre.${g}`) })));
}

function renderAlbums() {
  $("albums").replaceChildren(...state.pack.albums.map(renderAlbum));
  $("albums-empty").hidden = state.pack.albums.length > 0;
  $("btn-merge-all").hidden = state.pack.albums.length < 2;
  renderBulkGenre();
  refreshChrome();
}

// ---------------------------------------------------------------------------
// Paso 4: generar
// ---------------------------------------------------------------------------
function blockers() {
  const out = [];
  if (!packOk()) out.push(t("build.fixName"));
  if (!allTracks().length) out.push(t("build.fixMusic"));
  else if (badAlbums().length) out.push(t("build.fixAlbums"));
  return out;
}

function renderBuild() {
  const albums = state.pack.albums;
  const stat = (n, label) => el("div", { class: "stat" }, [el("b", { text: String(n) }), el("span", { text: label })]);
  $("review").replaceChildren(
    stat(albums.length, t("stat.albums")),
    stat(allTracks().length, t("stat.tracks")),
    stat(albums.filter((a) => a.formats.includes("cd")).length, t("stat.cd")),
    stat(albums.filter((a) => a.formats.includes("cassette")).length, t("stat.cassette")),
  );
  $("no-folders").hidden = canWriteFolders;
  document.querySelectorAll("[data-needs-folders]").forEach((d) => {
    d.classList.toggle("disabled", !canWriteFolders);
    if (!canWriteFolders) d.querySelector("input").checked = false;
  });
  if (!canWriteFolders) document.querySelector("input[name=dest][value=zip]").checked = true;
  $("dest-same").hidden = !state.opened;
  if (state.opened) {
    $("dest-same-label").textContent = state.opened.label;
    if (!state.building && !state.built) document.querySelector("input[name=dest][value=same]").checked = true;
  }
  const blocks = blockers();
  $("build-blocked").hidden = !blocks.length;
  $("build-blocked").textContent = blocks.length ? t("build.fixFirst", blocks.join(" · ")) : "";
  $("btn-build").disabled = !!blocks.length || state.building;
  refreshChrome();
}

function log(text, isError) {
  $("log").prepend(el("li", { class: isError ? "err" : "", text }));
}

function progress(fraction, text) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  $("progress").hidden = false;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-pct").textContent = `${pct}%`;
  if (text !== undefined) $("progress-text").textContent = text;
}

function showSuccess(dest) {
  const name = state.pack.name || state.pack.id;
  const key = dest === "workshop" ? "next.workshop" : dest === "zip" ? "next.zip" : "next.mods";
  $("success-title").textContent = t("build.success");
  $("next-list").replaceChildren(...t(key, name, state.pack.id).split("|").map((s) => el("li", { text: s })));
  $("next-steps").hidden = false;
  $("next-steps").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function chooseDestination(dest) {
  const id = state.pack.id;
  const modName = gen.modFolderName(id);
  if (dest === "mods") {
    const { writer, label, unusual } = await pickZomboidFolder("mods");
    if (unusual) log(t("build.unusualFolder", label));
    return { mod: new SubWriter(writer, modName), base: null, label, isFolder: true };
  }
  if (dest === "workshop") {
    const { writer, label, unusual } = await pickZomboidFolder("Workshop");
    if (unusual) log(t("build.unusualFolder", label));
    const base = new SubWriter(writer, modName);
    return { mod: new SubWriter(base, `Contents/mods/${modName}`), base, label, isFolder: true };
  }
  if (dest === "same") {
    return { mod: state.opened.writer, base: null, label: state.opened.label, isFolder: true, same: true };
  }
  const zip = new ZipWriter(`${modName}.zip`);
  return { mod: new SubWriter(zip, modName), base: null, zip, isFolder: false };
}

async function build() {
  const pack = state.pack;
  const dest = document.querySelector("input[name=dest]:checked").value;
  const normalize = $("opt-normalize").checked;
  let target;
  try {
    target = await chooseDestination(dest); // primero, mientras hay "gesto del usuario"
  } catch (e) {
    if (e.name !== "AbortError") log(String(e.message || e), true);
    return;
  }

  state.building = true;
  state.cancel = false;
  $("btn-build").disabled = true;
  $("btn-cancel").hidden = false;
  $("next-steps").hidden = true;
  $("progress-hint").hidden = false;
  $("log").replaceChildren();
  const paths = gen.paths(pack.id);
  const mod = target.mod;
  let ok = false;

  try {
    progress(0, t("build.loading"));
    await loadFFmpeg();

    const tracks = [];
    for (const album of pack.albums) for (const track of album.tracks) tracks.push({ album, track });
    const failed = new Set();
    let converted = 0;

    for (let i = 0; i < tracks.length; i++) {
      if (state.cancel) throw new Error("cancel");
      const { track } = tracks[i];
      const label = t("build.track", i + 1, tracks.length, track.title);
      const base = i / tracks.length;
      progress(base, label);
      if (track.existing && !track.file) {
        // ya convertida en el pack abierto: si se guarda en otro sitio, se copia
        if (!target.same) {
          const src = state.opened.writer;
          await mod.write(paths.sound(track.id, false), await src.read(paths.sound(track.id, false)));
          await mod.write(paths.sound(track.id, true), await src.read(paths.sound(track.id, true)));
        }
        continue;
      }
      try {
        const out = await convertTrack(track.file, {
          normalize,
          onProgress: (p) => progress(base + p / tracks.length, label),
        });
        await mod.write(paths.sound(track.id, false), out.ogg);
        await mod.write(paths.sound(track.id, true), out.muffled);
        track.duration = out.duration;
        converted++;
      } catch (e) {
        failed.add(track);
        log(t("build.failedTrack", track.title, e.message || e), true);
      }
    }

    // las pistas que no se pudieron convertir se quitan del pack
    for (const album of pack.albums) album.tracks = album.tracks.filter((tr) => !failed.has(tr));
    const albums = pack.albums.filter((a) => a.tracks.length > 0);

    progress(1, t("build.covers"));
    const coverPngs = [];
    for (const album of albums) {
      album.hasCover = false;
      if (album.coverBlob) {
        try {
          const png = await squareImage(album.coverBlob);
          await mod.write(paths.cover(album.id), png);
          album.hasCover = true;
          coverPngs.push(png);
        } catch (e) {
          log(`${album.title}: ${e.message || e}`, true);
        }
      }
    }

    progress(1, t("build.writing"));
    const out = { ...pack, albums };
    await mod.write(paths.sounds, gen.soundsScript(out));
    await mod.write(paths.lua, gen.packLua(out));
    await mod.write(paths.modInfo, gen.modInfo(out));
    await mod.write(paths.manifest, gen.manifest(out));
    await mod.write(paths.poster, await makePreview(coverPngs, pack.name || pack.id, 512));
    if (target.base) {
      await target.base.write("workshop.txt", gen.workshopTxt(out));
      await target.base.write("preview.png", await makePreview(coverPngs, pack.name || pack.id, 256));
    }
    if (target.isFolder) {
      // borra audios y carátulas de pistas/álbumes que ya no están en el pack
      const keepSounds = new Set(albums.flatMap((a) => a.tracks.flatMap((tr) => [`${tr.id}.ogg`, `${tr.id}_m.ogg`])));
      const keepCovers = new Set(albums.filter((a) => a.hasCover).map((a) => `${a.id}.png`));
      await mod.prune(paths.soundDir, keepSounds);
      await mod.prune(paths.coverDir, keepCovers);
    }
    if (target.zip) {
      progress(1, t("build.zipping"));
      await target.zip.finish((p) => progress(p, t("build.zipping")));
    }

    // a partir de ahora, el pack está en esa carpeta: se puede seguir editando sin reconvertir
    if (target.isFolder) {
      state.opened = { writer: mod, label: target.label };
      for (const tr of allTracks()) { tr.existing = true; tr.file = null; }
    }
    state.dirty = false;
    state.built = true;
    ok = true;
    progress(1, t("build.done", converted));
  } catch (e) {
    if (e.message === "cancel") {
      progress(0, t("build.cancelled"));
    } else {
      log(String(e.message || e), true);
      progress(0, String(e.message || e));
    }
  } finally {
    state.building = false;
    $("btn-cancel").hidden = true;
    $("progress-hint").hidden = true;
    renderBuild();
    if (ok) showSuccess(dest);
  }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function applyLanguage() {
  applyStatic();
  document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === getLang()));
  if (state.step === "music") renderAdded();
  if (state.step === "albums") renderAlbums();
  if (state.step === "build") renderBuild();
  if (!$("next-steps").hidden) showSuccess(document.querySelector("input[name=dest]:checked").value);
  refreshChrome();
}

function init() {
  setLang(getLang());
  applyLanguage();
  syncPackForm();

  if (MOD_URL) { $("link-mod").href = MOD_URL; $("link-mod").hidden = false; }

  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => { setLang(b.dataset.lang); applyLanguage(); }));
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => showStep(b.dataset.step)));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showStep(b.dataset.goto)));
  $("nav-next").addEventListener("click", goNext);
  $("nav-back").addEventListener("click", goBack);

  // portada
  $("btn-start").addEventListener("click", () => showWizard("pack"));
  $("btn-start-2").addEventListener("click", () => showWizard("pack"));
  $("btn-home-open").hidden = !canWriteFolders;
  $("btn-home-open").addEventListener("click", async () => { showWizard("pack"); await openExistingPack(); });
  $("brand-home").addEventListener("click", () => showHome());
  $("link-faq").addEventListener("click", (e) => { e.preventDefault(); showHome("faq"); });

  // paso 1
  $("pack-name").addEventListener("input", (e) => {
    state.pack.name = e.target.value;
    if (!state.idTouched) {
      state.pack.id = slugify(e.target.value);
      $("pack-id").value = state.pack.id;
    }
    validatePackId();
    markDirty();
    refreshChrome();
  });
  $("pack-name").addEventListener("keydown", (e) => { if (e.key === "Enter" && packOk()) goNext(); });
  $("pack-id").addEventListener("input", (e) => {
    state.idTouched = true;
    state.pack.id = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    e.target.value = state.pack.id;
    validatePackId();
    markDirty();
    refreshChrome();
  });
  $("pack-author").addEventListener("input", (e) => { state.pack.author = e.target.value; markDirty(); });
  $("pack-desc").addEventListener("input", (e) => { state.pack.description = e.target.value; markDirty(); });
  $("btn-new").addEventListener("click", () => {
    if (state.dirty && !confirm(t("unload"))) return;
    resetPack();
    toast(t("pack.newDone"));
    $("pack-name").focus();
  });
  $("btn-open").hidden = !canWriteFolders;
  $("btn-open").addEventListener("click", openExistingPack);

  // paso 3
  $("btn-merge-all").addEventListener("click", mergeAllAlbums);
  $("btn-new-album").addEventListener("click", () => {
    state.pack.albums.unshift(newAlbum({ open: true }));
    markDirty();
    renderAlbums();
  });
  $("bulk-genre").addEventListener("change", (e) => {
    if (!e.target.value) return;
    for (const a of state.pack.albums) if (!a.genre) a.genre = e.target.value;
    markDirty();
    renderAlbums();
  });

  // paso 4
  $("btn-build").addEventListener("click", build);
  $("btn-cancel").addEventListener("click", () => { state.cancel = true; });
  $("btn-another").addEventListener("click", () => {
    resetPack();
    showStep("pack");
  });

  setupDropzone();
  setupTabs();
  setupYouTube();
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty || state.building) {
      e.preventDefault();
      e.returnValue = t("unload");
    }
  });
  showHome();

  // Ganchos para pruebas automáticas (solo al abrir la web en tu propio PC)
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    window.KSSDebug = { state, addFiles, build, renderAlbums, showStep, showWizard, showHome, syncPackForm, lastZip: null, noDownload: true };
  }
}

init();
