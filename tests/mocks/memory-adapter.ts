export interface StatResult {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/** In-memory stand-in for Obsidian's DataAdapter. */
export class MemoryAdapter {
  private files = new Map<string, Uint8Array>();
  private folders = new Set<string>();
  private clock = 1000;

  private touch(): number {
    return (this.clock += 1000);
  }

  private ensureParents(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (acc) this.folders.add(acc);
    }
  }

  async write(path: string, data: string): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, new TextEncoder().encode(data));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, new Uint8Array(data.slice(0)));
  }

  async read(path: string): Promise<string> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(b);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b.slice().buffer;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path) || path === "";
  }

  async stat(path: string): Promise<StatResult | null> {
    if (this.files.has(path)) {
      const size = this.files.get(path)!.byteLength;
      return { type: "file", ctime: 1000, mtime: this.touch(), size };
    }
    if (this.folders.has(path) || path === "") {
      return { type: "folder", ctime: 1000, mtime: 1000, size: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(f);
      else folders.add(prefix + rest.slice(0, slash));
    }
    for (const d of this.folders) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest) continue;
      if (!rest.includes("/")) folders.add(d);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  async mkdir(path: string): Promise<void> {
    this.ensureParents(`${path}/x`);
    this.folders.add(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.folders.delete(path);
    if (recursive) {
      const p = `${path}/`;
      for (const f of [...this.files.keys()]) if (f.startsWith(p)) this.files.delete(f);
      for (const d of [...this.folders]) if (d.startsWith(p)) this.folders.delete(d);
    }
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  /** Test helper: snapshot of every file path currently present. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
