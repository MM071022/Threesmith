import { readFileSync } from "node:fs";

function read(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const VERSION = read();
