import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

export interface SourceFile {
  /** Path relative to the reviewed root, posix separators. */
  path: string;
  raw: string;
  /** Same length as raw, comments blanked out (newlines kept) so offsets and lines match. */
  text: string;
  /** Names imported from three / three/webgpu (local -> imported). */
  named: Map<string, string>;
  /** Local names that hold the whole three namespace (usually THREE). */
  namespaces: Set<string>;
  /** Where the namespace came from: "three" or "three/webgpu". */
  namespaceFrom: Map<string, string>;
  usesThree: boolean;
}

const EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".vue", ".svelte"]);
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".git", ".next", ".nuxt", "coverage", "out", ".threesmith", ".svelte-kit", "vendor"]);
const MAX_BYTES = 1_000_000;

/** Blank out // and block comments, keeping string contents and line structure. */
export function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
    } else if (c === "/" && d === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          out.push(src[i] as string);
          i++;
        }
        if (c !== "`" && src[i] === "\n") break;
        out.push(src[i] ?? "");
        i++;
      }
      if (i < n) {
        out.push(src[i] as string);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function lineText(raw: string, line: number): string {
  return (raw.split("\n")[line - 1] ?? "").trim().slice(0, 160);
}

/** Return the {...} block starting at the first "{" at or after `from`, and its start offset. */
export function blockAt(text: string, from: number): { start: number; end: number } | undefined {
  const open = text.indexOf("{", from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return undefined;
}

const THREE_MODULES = new Set(["three", "three/webgpu"]);

function parseImports(text: string, file: SourceFile): void {
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[2] ?? "";
    if (!THREE_MODULES.has(spec)) continue;
    file.usesThree = true;
    const clause = m[1] ?? "";
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns?.[1]) {
      file.namespaces.add(ns[1]);
      file.namespaceFrom.set(ns[1], spec);
    }
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) {
      for (const part of (braces[1] ?? "").split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const [imported, local] = p.split(/\s+as\s+/);
        if (imported) file.named.set(local ?? imported, imported);
      }
    }
  }
  if (/(?<!['"`\w$.])THREE\.[A-Z]/.test(text) || /(?:unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com)[^'"\s]*three/.test(text)) {
    file.usesThree = true;
    if (!file.namespaces.size) {
      file.namespaces.add("THREE");
      file.namespaceFrom.set("THREE", "three");
    }
  }
  if (/from\s+['"]three\/(?:addons|examples)\//.test(text) || /['"]three\/addons\//.test(text)) file.usesThree = true;
}

export function makeSourceFile(path: string, raw: string): SourceFile {
  const file: SourceFile = {
    path,
    raw,
    text: stripComments(raw),
    named: new Map(),
    namespaces: new Set(),
    namespaceFrom: new Map(),
    usesThree: false,
  };
  parseImports(file.text, file);
  return file;
}

export interface Collected {
  files: SourceFile[];
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  skipped: number;
}

/** Read a file without a check-then-read gap: open it once, check its size on the handle, read from the handle. */
export function readLimited(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (fstatSync(fd).size > MAX_BYTES) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function collect(root: string): Collected {
  const files: SourceFile[] = [];
  let skipped = 0;
  let packageJson: Collected["packageJson"];
  const parsePackage = (text: string | undefined): Collected["packageJson"] => {
    try {
      return text ? (JSON.parse(text) as Collected["packageJson"]) : undefined;
    } catch {
      return undefined;
    }
  };
  const addFile = (path: string, base: string): void => {
    const name = path.split(/[\\/]/).pop() ?? "";
    if (!EXT.has(extname(path)) || name.includes(".min.") || name.endsWith(".d.ts")) return;
    const text = readLimited(path);
    if (text === undefined) {
      skipped++;
      return;
    }
    files.push(makeSourceFile(relative(base, path).split("\\").join("/"), text));
  };
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(p, base);
      } else if (entry.isFile()) addFile(p, base);
    }
  };
  let base = root;
  try {
    walk(root, root);
  } catch (e) {
    // a single file was given
    if ((e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
    base = join(root, "..");
    addFile(root, base);
  }
  packageJson = parsePackage(readLimited(join(base, "package.json")));
  return { files, ...(packageJson ? { packageJson } : {}), skipped };
}
