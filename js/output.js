// KSS Pack Builder - escritura del pack: directo en la carpeta de Zomboid (Chrome/Edge) o en un .zip.

export const canWriteFolders = typeof window !== "undefined" && "showDirectoryPicker" in window;

// --- Escritor en carpeta (File System Access API) ---------------------------
export class FolderWriter {
  constructor(root) {
    this.root = root;
    this.dirs = new Map();
  }

  async dir(path, create = true) {
    if (!path) return this.root;
    if (this.dirs.has(path)) return this.dirs.get(path);
    let handle = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      handle = await handle.getDirectoryHandle(part, { create });
    }
    this.dirs.set(path, handle);
    return handle;
  }

  async write(path, data) {
    const i = path.lastIndexOf("/");
    const dir = await this.dir(i >= 0 ? path.slice(0, i) : "");
    const file = await dir.getFileHandle(path.slice(i + 1), { create: true });
    const stream = await file.createWritable();
    await stream.write(data);
    await stream.close();
  }

  async exists(path) {
    try {
      const i = path.lastIndexOf("/");
      const dir = await this.dir(i >= 0 ? path.slice(0, i) : "", false);
      await dir.getFileHandle(path.slice(i + 1));
      return true;
    } catch (e) {
      return false;
    }
  }

  async read(path) {
    const i = path.lastIndexOf("/");
    const dir = await this.dir(i >= 0 ? path.slice(0, i) : "", false);
    const handle = await dir.getFileHandle(path.slice(i + 1));
    return handle.getFile();
  }

  // Borra los archivos de una carpeta que no estén en la lista "keep" (pistas eliminadas)
  async prune(dirPath, keep) {
    let dir;
    try {
      dir = await this.dir(dirPath, false);
    } catch (e) {
      return 0;
    }
    let removed = 0;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && !keep.has(name)) {
        await dir.removeEntry(name);
        removed++;
      }
    }
    return removed;
  }

  async finish() {}
}

// Escritor en una subcarpeta de otro escritor
export class SubWriter {
  constructor(parent, prefix) {
    this.parent = parent;
    this.prefix = prefix.replace(/\/+$/, "") + "/";
  }
  write(path, data) { return this.parent.write(this.prefix + path, data); }
  exists(path) { return this.parent.exists(this.prefix + path); }
  read(path) { return this.parent.read(this.prefix + path); }
  prune(dirPath, keep) { return this.parent.prune(this.prefix + dirPath, keep); }
  finish() { return this.parent.finish(); }
}

// --- Escritor en .zip (cualquier navegador) ---------------------------------
export class ZipWriter {
  constructor(fileName) {
    this.zip = new window.JSZip();
    this.fileName = fileName;
  }
  async write(path, data) { this.zip.file(path, data); }
  async exists() { return false; }
  async read() { throw new Error("zip"); }
  async prune() { return 0; }
  async finish(onProgress) {
    const blob = await this.zip.generateAsync({ type: "blob", compression: "STORE" },
      (meta) => onProgress && onProgress(meta.percent / 100));
    if (window.KSSDebug) {
      // pruebas en localhost: guardar el zip en memoria en vez de descargarlo
      window.KSSDebug.lastZip = blob;
      if (window.KSSDebug.noDownload) return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// --- Elegir carpeta de Zomboid ----------------------------------------------
// Acepta la carpeta "Zomboid", "mods" o "Workshop". Devuelve el escritor apuntando a la carpeta pedida.
export async function pickZomboidFolder(target) {
  const handle = await window.showDirectoryPicker({ id: "kss-zomboid", mode: "readwrite" });
  const name = handle.name.toLowerCase();
  const writer = new FolderWriter(handle);
  if (name === target.toLowerCase()) return { writer, label: handle.name };
  if (name === "zomboid") {
    return { writer: new SubWriter(writer, target), label: `${handle.name}/${target}` };
  }
  return { writer, label: handle.name, unusual: true };
}

// Abre una carpeta de pack ya generada (KSS_Pack_xxx) para reeditarla
export async function pickPackFolder() {
  const handle = await window.showDirectoryPicker({ id: "kss-pack", mode: "readwrite" });
  const writer = new FolderWriter(handle);
  const manifestFile = await writer.read("kss_pack.json");
  const manifest = JSON.parse(await manifestFile.text());
  return { writer, manifest, label: handle.name };
}
