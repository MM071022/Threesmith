/**
 * Plain-ASCII output for consoles that would garble UTF-8. Windows PowerShell decodes a piped program's output with
 * the console's old code page, so `✖` turns into `Ôƒû` as soon as the output goes through `| Select-Object` or into
 * a variable, which is how agents on Windows usually read it. THREESMITH_ASCII=1 forces ASCII, =0 keeps Unicode;
 * by default it is ASCII on Windows when stdout is not a terminal.
 */

const MAP: Record<string, string> = {
  "✖": "x",
  "▲": "!",
  "✔": "ok",
  "✅": "[pass]",
  "❌": "[fail]",
  "·": "-",
  "•": "*",
  "–": "-",
  "—": "-",
  "…": "...",
  "→": "->",
  "’": "'",
  "«": "<<",
  "»": ">>",
  "±": "+/-",
  "°": " deg",
};

const PATTERN = new RegExp(`[${Object.keys(MAP).join("")}]`, "gu");

export function useAscii(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, tty: boolean = Boolean(process.stdout.isTTY)): boolean {
  const flag = env["THREESMITH_ASCII"]?.trim();
  if (flag) return /^(1|true|yes|on)$/i.test(flag);
  return platform === "win32" && !tty;
}

/** The text with the symbols Threesmith prints replaced by ASCII; other text (file names, messages) stays as it is. */
export function toAscii(text: string): string {
  return text.replace(PATTERN, (ch) => MAP[ch] ?? ch);
}
