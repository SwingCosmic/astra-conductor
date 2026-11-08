import { readFile } from "node:fs/promises";
import path from "node:path";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
export async function graphUiResource(root: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filename = path.resolve(root, relative);
  if (
    !filename.startsWith(`${path.resolve(root)}${path.sep}`) ||
    relative.includes("\\") ||
    relative.includes("\0")
  )
    return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(filename);
    return new Response(bytes, {
      headers: {
        "Content-Type": mime[path.extname(filename)] ?? "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return new Response(null, { status: 404 });
    throw error;
  }
}
