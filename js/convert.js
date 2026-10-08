// KSS Pack Builder - conversión con ffmpeg.wasm (todo dentro del navegador, nada sale del PC).

import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { fetchFile } from "../vendor/util/index.js";
import { audioArgs, MUFFLED_ARGS, COVER_SIZE, PREVIEW_SIZE, extOf } from "./constants.js";

let ffmpeg = null;
let loading = null;
let logLines = [];
let progressHandler = null;

export async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    const instance = new FFmpeg();
    instance.on("log", ({ message }) => {
      logLines.push(message);
      if (logLines.length > 400) logLines.shift();
    });
    instance.on("progress", ({ progress }) => {
      if (progressHandler) progressHandler(Math.max(0, Math.min(1, progress)));
    });
    const base = new URL("../vendor/core/", import.meta.url).href;
    await instance.load({
      coreURL: base + "ffmpeg-core.js",
      wasmURL: base + "ffmpeg-core.wasm",
    });
    ffmpeg = instance;
    return instance;
  })();
  return loading;
}

function parseDuration(lines) {
  for (const line of lines) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  return 0;
}

// Duración leyendo el archivo con el propio navegador (por si ffmpeg no la da)
function durationFromAudio(blob) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    audio.src = url;
  });
}

// Convierte una pista: devuelve { ogg, muffled, duration }
// onProgress(0..1) informa del avance de esta pista.
export async function convertTrack(file, { normalize = true, onProgress } = {}) {
  const ff = await loadFFmpeg();
  const input = `in.${extOf(file.name) || "bin"}`;
  try {
    await ff.writeFile(input, await fetchFile(file));
    logLines = [];
    progressHandler = (p) => onProgress && onProgress(p * 0.8);
    const code = await ff.exec(["-y", "-i", input, ...audioArgs(normalize), "out.ogg"]);
    if (code !== 0) throw new Error(lastError() || "ffmpeg");
    const inputDuration = parseDuration(logLines);
    const ogg = await ff.readFile("out.ogg");

    progressHandler = (p) => onProgress && onProgress(0.8 + p * 0.2);
    const code2 = await ff.exec(["-y", "-i", "out.ogg", ...MUFFLED_ARGS, "muf.ogg"]);
    if (code2 !== 0) throw new Error(lastError() || "ffmpeg (muffled)");
    const muffled = await ff.readFile("muf.ogg");

    let duration = inputDuration;
    if (!duration) duration = await durationFromAudio(new Blob([ogg], { type: "audio/ogg" }));
    return { ogg, muffled, duration };
  } finally {
    progressHandler = null;
    for (const name of [input, "out.ogg", "muf.ogg"]) {
      try { await ff.deleteFile(name); } catch (e) { /* no existía */ }
    }
  }
}

function lastError() {
  const errors = logLines.filter((l) => /error|invalid|failed/i.test(l));
  return errors.slice(-2).join(" | ");
}

// ---------------------------------------------------------------------------
// Imágenes (carátulas y preview del Workshop) con canvas
// ---------------------------------------------------------------------------
export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}

function canvasToPng(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

// Recorta en cuadrado (centro) y reduce
export async function squareImage(blob, size = COVER_SIZE) {
  const img = await loadImage(blob);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return canvasToPng(canvas);
}

// Preview del Workshop / poster del mod: mosaico de carátulas con el nombre del pack
export async function makePreview(coverBlobs, title, size = PREVIEW_SIZE) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "#2a1f3a");
  grad.addColorStop(1, "#4e2a4a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const covers = coverBlobs.slice(0, 4);
  const n = covers.length >= 4 ? 2 : 1;
  const cell = size / n;
  for (let i = 0; i < Math.min(covers.length, n * n); i++) {
    try {
      const img = await loadImage(covers[i]);
      ctx.drawImage(img, (i % n) * cell, Math.floor(i / n) * cell, cell, cell);
    } catch (e) { /* carátula ilegible */ }
  }
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, size * 0.72, size, size * 0.28);
  ctx.fillStyle = "#ffcd50";
  ctx.font = `bold ${Math.round(size * 0.075)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("KSS PACK", size / 2, size * 0.81);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(size * 0.065)}px Arial, sans-serif`;
  let text = String(title || "");
  while (ctx.measureText(text).width > size * 0.92 && text.length > 3) text = text.slice(0, -2) + "…";
  ctx.fillText(text, size / 2, size * 0.92);
  return canvasToPng(canvas);
}
