import type { ApiIndex } from "../api/index-builder.js";
import type { ThreeInstall } from "../api/types.js";
import type { SourceFile } from "./source.js";

export type Severity = "error" | "warn" | "info";
export type Category = "correctness" | "api" | "performance" | "lifecycle" | "color";

export interface Finding {
  rule: string;
  category: Category;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  fix: string;
  snippet: string;
}

export interface Ctx {
  files: SourceFile[];
  /** Files that use three.js. Project-level rules look at these together. */
  three: SourceFile[];
  install?: ThreeInstall;
  index?: ApiIndex;
  /** Installed release number; Infinity when no install was found (assume the newest). */
  release: number;
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  /** All three-file text joined, for "does the project ever do X" checks. */
  all: string;
}

export interface Report {
  (file: SourceFile, index: number, extra?: { message?: string; fix?: string; severity?: Severity }): void;
}

export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  message: string;
  fix: string;
  /** Release in which the modern replacement exists. The rule is skipped for older installs. */
  introducedIn?: number;
  /** Release in which the old API was removed: error when the install is at or past it. */
  removedIn?: number;
  deprecatedIn?: number;
  check(ctx: Ctx, report: Report): void;
}
