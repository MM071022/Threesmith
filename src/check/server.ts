import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Serve a folder on 127.0.0.1 with a random port. Never serves anything outside the folder. */
export async function serveStatic(root: string): Promise<StaticServer> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      if (pathname.includes("\0")) {
        res.writeHead(400).end("bad request");
        return;
      }
      // lexical containment: resolve against the root and refuse anything that leaves it
      // (symlinks inside the folder are followed on purpose: pnpm links node_modules to a store)
      const target = resolve(base, "." + sep + pathname.replace(/^[/\\]+/, ""));
      const rel = relative(base, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      let body: Buffer | undefined;
      let served = target;
      try {
        body = readFileSync(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EISDIR") {
          served = join(target, "index.html");
          try {
            body = readFileSync(served);
          } catch {
            body = undefined;
          }
        }
      }
      if (!body) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(served)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(500).end("error");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
