import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertWritable } from "./protect.js";

/**
 * Every file a Threesmith write touches is kept as it was before, one entry per call, in .threesmith/journal/, so
 * the last writes can be undone: an agent that did not commit between steps gets its project back, and the journal
 * says which tool changed which files. A file changed again by hand after the write is left alone unless forced.
 */

const KEEP = 40;
const MAX_COPY = 64 * 1024 * 1024;

export interface JournalFile {
  /** Path relative to the project, posix separators. */
  file: string;
  existed: boolean;
  /** Hash of the file after the write. */
  after: string;
  /** Too big to keep a copy: undo cannot restore it. */
  notKept?: boolean;
}

export interface JournalEntry {
  id: number;
  tool: string;
  summary: string;
  date: string;
  files: JournalFile[];
}

const hash = (data: Uint8Array | string): string => createHash("sha1").update(data).digest("hex");

function fileHash(full: string): string {
  try {
    return hash(readFileSync(full));
  } catch {
    return "";
  }
}

export const stateDir = (root: string): string => join(root, ".threesmith");
const journalDir = (root: string): string => join(stateDir(root), "journal");

/** .threesmith/ holds baselines (commit them) and local state (journal, review memory): ignore the local part. */
export function ensureStateDir(root: string): string {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  {
    try {
      // "wx": create it only when it is not there yet, in one step (an existing one is kept as it is)
      writeFileSync(ignore, "# local Threesmith state; baselines/ and scenarios/ are meant to be committed\njournal/\nreview-last.json\nlast.png\ndiff/\nperf/\n", { flag: "wx" });
    } catch {
      /* already there, or a read-only project */
    }
  }
  return dir;
}

function entryIds(root: string): number[] {
  const dir = journalDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d+$/.test(d) && existsSync(join(dir, d, "entry.json")))
    .map(Number)
    .sort((a, b) => a - b);
}

const rel = (root: string, full: string): string => relative(root, full).split(sep).join("/");

/** The file as it is now, read through one handle (size and contents of the same file), or that it is not there. */
function previous(full: string): { existed: boolean; data?: Buffer; notKept?: boolean } {
  let fd: number;
  try {
    fd = openSync(full, "r");
  } catch {
    return { existed: false };
  }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_COPY) return { existed: true, notKept: true };
    const data = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, data, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { existed: true, data: data.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

/** One call's writes. Every write goes through `write`; `commit` stores the entry when something was written. */
export class JournalWriter {
  private readonly root: string;
  private readonly before = new Map<string, { existed: boolean; data?: Buffer; notKept?: boolean }>();
  private readonly written = new Set<string>();

  constructor(
    root: string,
    private readonly tool: string,
    private readonly summary: string,
  ) {
    this.root = resolve(root);
  }

  /** Write a file in the project (asks protect first, keeps the old content for undo). */
  write(file: string, data: string | Uint8Array): void {
    const full = resolve(this.root, file);
    if (rel(this.root, full).startsWith("..")) throw new Error(`${file} is outside the project ${this.root}; nothing was written.`);
    assertWritable(this.root, full);
    const key = rel(this.root, full);
    if (!this.before.has(key)) {
      this.before.set(key, previous(full));
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    this.written.add(key);
  }

  /** Store the entry. Returns its id, or 0 when nothing was written. */
  commit(): number {
    if (!this.written.size) return 0;
    const ids = entryIds(this.root);
    const id = (ids[ids.length - 1] ?? 0) + 1;
    const dir = join(journalDir(this.root), String(id));
    try {
      ensureStateDir(this.root);
      mkdirSync(join(dir, "files"), { recursive: true });
      const files: JournalFile[] = [];
      let n = 0;
      for (const key of this.written) {
        const b = this.before.get(key) ?? { existed: false };
        const entry: JournalFile = { file: key, existed: b.existed, after: fileHash(join(this.root, key)), ...(b.notKept ? { notKept: true } : {}) };
        if (b.data) writeFileSync(join(dir, "files", String(n)), b.data);
        files.push(entry);
        n++;
      }
      const data: JournalEntry = { id, tool: this.tool, summary: this.summary, date: new Date().toISOString(), files };
      writeFileSync(join(dir, "entry.json"), JSON.stringify(data, null, 1));
      for (const old of ids.slice(0, Math.max(0, ids.length + 1 - KEEP))) rmSync(join(journalDir(this.root), String(old)), { recursive: true, force: true });
    } catch {
      /* the write itself worked; only undo is lost */
    }
    return id;
  }
}

/** Write files as one undoable step. */
export function writeFiles(root: string, tool: string, summary: string, files: { file: string; data: string | Uint8Array }[]): number {
  const w = new JournalWriter(root, tool, summary);
  for (const f of files) w.write(f.file, f.data);
  return w.commit();
}

export function readJournal(root: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const id of entryIds(resolve(root)).reverse()) {
    try {
      out.push(JSON.parse(readFileSync(join(journalDir(resolve(root)), String(id), "entry.json"), "utf8")) as JournalEntry);
    } catch {
      /* broken entry */
    }
  }
  return out;
}

export interface UndoResult {
  undone: { id: number; tool: string; summary: string; restored: string[]; removed: string[] }[];
  /** Files left alone because they changed since the write (use force), or could not be restored. */
  skipped: { file: string; why: string }[];
}

/** Undo the last `steps` entries, newest first. A file changed since the write is skipped unless `force`. */
export function undoJournal(root: string, opts: { steps?: number; force?: boolean } = {}): UndoResult {
  const base = resolve(root);
  const ids = entryIds(base).reverse().slice(0, Math.max(1, opts.steps ?? 1));
  const res: UndoResult = { undone: [], skipped: [] };
  for (const id of ids) {
    const dir = join(journalDir(base), String(id));
    let entry: JournalEntry;
    try {
      entry = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8")) as JournalEntry;
    } catch {
      continue;
    }
    const restored: string[] = [];
    const removed: string[] = [];
    entry.files.forEach((f, n) => {
      const full = join(base, f.file);
      if (!opts.force && fileHash(full) !== f.after) {
        res.skipped.push({ file: f.file, why: "changed since the write (force: true restores it anyway)" });
        return;
      }
      if (f.notKept) {
        res.skipped.push({ file: f.file, why: "too big, no copy was kept" });
        return;
      }
      try {
        assertWritable(base, full);
        if (f.existed) {
          writeFileSync(full, readFileSync(join(dir, "files", String(n))));
          restored.push(f.file);
        } else {
          rmSync(full, { force: true });
          removed.push(f.file);
        }
      } catch (e) {
        res.skipped.push({ file: f.file, why: (e as Error).message });
      }
    });
    rmSync(dir, { recursive: true, force: true });
    res.undone.push({ id, tool: entry.tool, summary: entry.summary, restored, removed });
  }
  return res;
}

export function formatJournal(entries: JournalEntry[], limit = 10): string {
  if (!entries.length) return "No Threesmith writes to undo in this project.";
  const out = [`Last Threesmith writes (newest first):`];
  for (const e of entries.slice(0, limit)) out.push(`  #${e.id} ${e.date.slice(0, 19).replace("T", " ")} ${e.tool}: ${e.summary} (${e.files.map((f) => f.file).join(", ")})`);
  if (entries.length > limit) out.push(`  +${entries.length - limit} older`);
  return out.join("\n");
}

export function formatUndo(r: UndoResult): string {
  if (!r.undone.length && !r.skipped.length) return "Nothing to undo.";
  const out: string[] = [];
  for (const u of r.undone) {
    out.push(`undid #${u.id} ${u.tool}: ${u.summary}`);
    for (const f of u.restored) out.push(`  restored ${f}`);
    for (const f of u.removed) out.push(`  removed ${f} (it was new)`);
  }
  for (const s of r.skipped) out.push(`  left alone ${s.file}: ${s.why}`);
  return out.join("\n");
}
