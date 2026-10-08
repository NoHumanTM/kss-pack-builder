// KSS Pack Builder - aplicación principal.

import { t, applyStatic, getLang, setLang } from "./i18n.js";
import {
  GENRES, RARITIES, FORMATS, PACK_ID_RE, AUDIO_EXT, IMAGE_EXT,
  newId, slugify, extOf, formatTime,
} from "./constants.js";
import { readTrackInfo, isCoverImage, groupKey } from "./tags.js";
import { loadFFmpeg, convertTrack, squareImage, makePreview } from "./convert.js";
import * as gen from "./packgen.js";
import { canWriteFolders, ZipWriter, SubWriter, pickZomboidFolder, pickPackFolder } from "./output.js";
import { parseYouTubeUrl, buildCommand } from "./youtube.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const state = {
  pack: { id: "", name: "", author: "", description: "", albums: [] },
  idTouched: false,
  opened: null,     // { writer, label } si se abrió un pack existente o ya se generó en una carpeta
  dirty: false,
  building: false,
  cancel: false,
  step: "pack",
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
}

function allTracks() {
  return state.pack.albums.flatMap((a) => a.tracks);
}

// ---------------------------------------------------------------------------
// Navegación entre pasos
// ---------------------------------------------------------------------------
function showStep(step) {
  state.step = step;
  for (const s of ["pack", "music", "albums", "build"]) {
    $(`step-${s}`).hidden = s !== step;
  }
  document.querySelectorAll("#steps button").forEach((b) => b.classList.toggle("active", b.dataset.step === step));
  if (step === "albums") renderAlbums();
  if (step === "build") renderBuild();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  $("pack-id").classList.toggle("invalid", !ok);
  return ok;
}

function notice(id, text) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !text;
}

function resetPack() {
  for (const a of state.pack.albums) setCover(a, null);
  state.pack = { id: "", name: "", author: "", description: "", albums: [] };
  state.idTouched = false;
  state.opened = null;
  state.dirty = false;
  notice("pack-notice", "");
  syncPackForm();
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

async function addFiles(files) {
  const audio = files.filter((f) => AUDIO_EXT.includes(extOf(f.name)));
  const covers = new Map(); // carpeta -> imagen de carátula
  for (const f of files) {
    if (IMAGE_EXT.includes(extOf(f.name)) && isCoverImage(f)) covers.set(folderPath(f), f);
  }
  if (!audio.length) return;

  const groups = new Map();
  for (let i = 0; i < audio.length; i++) {
    notice("music-notice", t("music.reading", i + 1, audio.length));
    const info = await readTrackInfo(audio[i]);
    const key = groupKey(info);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(info);
  }

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
  markDirty();
  notice("music-notice", t("music.added", added, albumsTouched));
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
      $("yt-copy").textContent = t("yt.copied");
      setTimeout(() => { $("yt-copy").textContent = t("yt.copy"); }, 1500);
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
  return w;
}

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
        target = newAlbum({ title: track.title, artist: album.artist, genre: album.genre, formats: [...album.formats] });
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
    el("input", { type: "text", value: track.title, oninput: (e) => { track.title = e.target.value; markDirty(); } }),
    el("span", { class: "dur", text: track.existing ? `${formatTime(track.duration)} · ${t("track.kept")}` : (track.duration ? formatTime(track.duration) : "") }),
    move,
    el("button", {
      class: "remove", type: "button", title: t("track.remove"), text: "×",
      onclick: () => { album.tracks.splice(album.tracks.indexOf(track), 1); markDirty(); renderAlbums(); },
    }),
  );
  return row;
}

function renderAlbum(album) {
  const warnings = albumWarnings(album);
  const card = el("article", { class: "album" + (warnings.length ? " has-warnings" : "") });

  // carátula
  const coverInput = el("input", { type: "file", accept: "image/*", hidden: true });
  const cover = el("div", { class: "cover", title: t("album.cover") }, album.coverUrl ? [] : [t("album.cover")]);
  if (album.coverUrl) cover.style.backgroundImage = `url("${album.coverUrl}")`;
  cover.addEventListener("click", () => coverInput.click());
  coverInput.addEventListener("change", () => {
    if (coverInput.files[0]) { setCover(album, coverInput.files[0]); markDirty(); renderAlbums(); }
  });
  cover.addEventListener("dragover", (e) => { if (!dragged) { e.preventDefault(); cover.classList.add("over"); } });
  cover.addEventListener("dragleave", () => cover.classList.remove("over"));
  cover.addEventListener("drop", (e) => {
    if (dragged) return;
    e.preventDefault();
    cover.classList.remove("over");
    const img = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (img) { setCover(album, img); markDirty(); renderAlbums(); }
  });

  // campos
  const input = (key, attrs = {}) => el("input", {
    type: "text", value: album[key] ?? "", ...attrs,
    oninput: (e) => { album[key] = e.target.value; markDirty(); },
    onchange: () => renderAlbums(),
  });
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
    t(`format.${f}`),
  ])));

  const side = el("div", { class: "album-side" }, [
    warnings.length ? el("div", { class: "warnings" }, warnings.map((w) => el("span", { text: w }))) : null,
    el("div", { class: "album-fields" }, [
      el("label", {}, [el("span", { text: t("album.title") }), input("title")]),
      el("label", {}, [el("span", { text: t("album.artist") }), input("artist")]),
      el("label", {}, [el("span", { text: t("album.year") }), input("year", { inputmode: "numeric", maxlength: 4 })]),
    ]),
    el("div", { class: "album-fields2" }, [
      el("label", {}, [el("span", { text: t("album.genre") }), genreSelect]),
      el("label", {}, [el("span", { text: t("album.rarity") }), raritySelect]),
      el("label", {}, [el("span", { text: t("album.formats") }), formats]),
    ]),
    album.genre ? el("button", {
      class: "link", type: "button", text: t("album.applyGenre"),
      onclick: () => { for (const a of state.pack.albums) if (!a.genre) a.genre = album.genre; markDirty(); renderAlbums(); },
    }) : null,
    el("ol", { class: "tracks" }, album.tracks.map((tr, i) => renderTrack(album, tr, i))),
    el("div", { class: "album-actions" }, [el("button", {
      class: "link", type: "button", text: t("album.delete"),
      onclick: () => {
        if (!confirm(t("album.deleteConfirm", album.title, album.tracks.length))) return;
        setCover(album, null);
        state.pack.albums.splice(state.pack.albums.indexOf(album), 1);
        markDirty();
        renderAlbums();
      },
    })]),
  ]);

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

  card.append(el("div", {}, [cover, coverInput]), side);
  return card;
}

function renderAlbums() {
  // quita álbumes vacíos que se quedaron sin pistas al moverlas (salvo si se crearon a mano)
  const container = $("albums");
  container.replaceChildren(...state.pack.albums.map(renderAlbum));
  const tracks = allTracks();
  const total = tracks.reduce((s, tr) => s + (tr.duration || 0), 0);
  $("albums-summary").textContent = t("albums.summary", state.pack.albums.length, tracks.length,
    total ? formatTime(total) : "—");
  $("albums-empty").hidden = state.pack.albums.length > 0;
}

// ---------------------------------------------------------------------------
// Paso 4: generar
// ---------------------------------------------------------------------------
function renderBuild() {
  $("no-folders").hidden = canWriteFolders;
  document.querySelectorAll("[data-needs-folders]").forEach((d) => {
    d.classList.toggle("disabled", !canWriteFolders);
    if (!canWriteFolders) d.querySelector("input").checked = false;
  });
  if (!canWriteFolders) document.querySelector("input[name=dest][value=zip]").checked = true;
  $("dest-same").hidden = !state.opened;
  if (state.opened) $("dest-same-label").textContent = state.opened.label;
  const blocked = !validatePackId() || !allTracks().length || state.pack.albums.some((a) => albumWarnings(a).length);
  $("build-blocked").hidden = !blocked;
  $("btn-build").disabled = blocked || state.building;
}

function log(text, isError) {
  const li = el("li", { class: isError ? "err" : "", text });
  $("log").prepend(li);
}

function progress(fraction, text) {
  $("progress").hidden = false;
  $("progress-fill").style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (text !== undefined) $("progress-text").textContent = text;
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
  $("log").replaceChildren();
  const paths = gen.paths(pack.id);
  const mod = target.mod;

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
    progress(1, t("build.done", converted));
    const next = dest === "workshop" ? t("next.workshop", pack.id) : dest === "zip" ? t("next.zip") : t("next.mods", pack.name || pack.id);
    notice("next-steps", next);
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
    renderBuild();
    renderAlbums();
  }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function applyLanguage() {
  applyStatic();
  document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === getLang()));
  if (state.step === "albums") renderAlbums();
  if (state.step === "build") renderBuild();
}

function init() {
  setLang(getLang());
  applyLanguage();
  syncPackForm();

  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => { setLang(b.dataset.lang); applyLanguage(); }));
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => showStep(b.dataset.step)));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showStep(b.dataset.goto)));

  $("pack-name").addEventListener("input", (e) => {
    state.pack.name = e.target.value;
    if (!state.idTouched) {
      state.pack.id = slugify(e.target.value);
      $("pack-id").value = state.pack.id;
    }
    validatePackId();
    markDirty();
  });
  $("pack-id").addEventListener("input", (e) => {
    state.idTouched = true;
    state.pack.id = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    e.target.value = state.pack.id;
    validatePackId();
    markDirty();
  });
  $("pack-author").addEventListener("input", (e) => { state.pack.author = e.target.value; markDirty(); });
  $("pack-desc").addEventListener("input", (e) => { state.pack.description = e.target.value; markDirty(); });
  $("btn-new").addEventListener("click", () => {
    if (state.dirty && !confirm(t("unload"))) return;
    resetPack();
  });
  $("btn-open").hidden = !canWriteFolders;
  $("open-hint").hidden = !canWriteFolders;
  $("btn-open").addEventListener("click", openExistingPack);
  $("btn-new-album").addEventListener("click", () => {
    state.pack.albums.unshift(newAlbum());
    markDirty();
    renderAlbums();
  });

  setupDropzone();
  setupYouTube();
  $("btn-build").addEventListener("click", build);
  $("btn-cancel").addEventListener("click", () => { state.cancel = true; });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty || state.building) {
      e.preventDefault();
      e.returnValue = t("unload");
    }
  });
  showStep("pack");

  // Ganchos para pruebas automáticas (solo al abrir la web en tu propio PC)
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    window.KSSDebug = { state, addFiles, build, renderAlbums, showStep, syncPackForm, lastZip: null, noDownload: true };
  }
}

init();
