export type ImageFormat = "png" | "jpeg" | "webp" | "ktx2";

/** Reads width and height from a PNG, JPEG, WebP or KTX2 header without decoding it. */
export function imageSize(bytes: Buffer): { width: number; height: number; format: ImageFormat } | undefined {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < bytes.length) {
      if (bytes[pos] !== 0xff) { pos++; continue; }
      const marker = bytes[pos + 1] ?? 0;
      if (marker === 0xff) { pos++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(pos + 5), width: bytes.readUInt16BE(pos + 7), format: "jpeg" };
      }
      pos += 2 + bytes.readUInt16BE(pos + 2);
    }
  }
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return webpSize(bytes);
  // KTX2: «KTX 20», then vkFormat, typeSize, pixelWidth, pixelHeight (little endian).
  if (bytes.length >= 28 && bytes[0] === 0xab && bytes.toString("latin1", 1, 7) === "KTX 20") {
    return { width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24), format: "ktx2" };
  }
  return undefined;
}

function webpSize(bytes: Buffer): { width: number; height: number; format: "webp" } | undefined {
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), format: "webp" };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: "webp" };
  }
  if (chunk === "VP8 " && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, format: "webp" };
  return undefined;
}
