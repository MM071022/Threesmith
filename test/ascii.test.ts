import { describe, expect, it } from "vitest";
import { toAscii, useAscii } from "../src/ascii.js";

describe("ascii output", () => {
  it("is on for a Windows pipe, off for a terminal and elsewhere, and can be forced", () => {
    expect(useAscii({}, "win32", false)).toBe(true);
    expect(useAscii({}, "win32", true)).toBe(false);
    expect(useAscii({}, "linux", false)).toBe(false);
    expect(useAscii({ THREESMITH_ASCII: "1" }, "linux", true)).toBe(true);
    expect(useAscii({ THREESMITH_ASCII: "0" }, "win32", false)).toBe(false);
  });
  it("replaces only the symbols", () => {
    expect(toAscii("2. ✖ Assets – 404 … ▲ warn · ok → next ✔ café")).toBe("2. x Assets - 404 ... ! warn - ok -> next ok café");
  });
});
