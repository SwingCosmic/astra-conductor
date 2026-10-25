import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Explicit application registrations only. Never serves the renderer build. */
export class ElectronDynamicResourceService {
  private readonly entries: ReadonlyMap<string, string>;

  constructor(
    private readonly root: string,
    entries: ReadonlyMap<string, string> = new Map(),
  ) {
    this.entries = new Map(entries);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || !/^\/[a-z0-9-]+$/.test(url.pathname) || url.search)
      return new Response(null, { status: 404 });
    const entry = this.entries.get(url.pathname.slice(1));
    if (!entry) return new Response(null, { status: 404 });
    try {
      const root = await realpath(this.root);
      const file = await realpath(path.resolve(root, entry));
      const relative = path.relative(root, file);
      const type = mimeTypes[path.extname(file).toLowerCase()];
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative) ||
        !type
      )
        return new Response(null, { status: 404 });
      const info = await stat(file);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) return new Response(null, { status: 404 });
      const contents = await readFile(file, { signal: request.signal });
      return new Response(new Uint8Array(contents), {
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
}
