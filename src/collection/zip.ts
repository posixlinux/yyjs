import { inflateRawSync } from "node:zlib";
import { CollectionError } from "./types.js";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface ZipFile {
  name: string;
  data: Buffer;
}

export const isZip = (b: Buffer): boolean => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;

/**
 * Minimal ZIP reader (stored + deflate, no ZIP64/encryption). Decompression is bounded by
 * maxOutputLength so a lying header cannot expand past the limits. CRCs are not checked.
 */
export function unzip(buf: Buffer, limits: ZipLimits, accept: (name: string) => boolean = () => true): ZipFile[] {
  try {
    return read(buf, limits, accept);
  } catch (e) {
    if (e instanceof CollectionError) throw e;
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new CollectionError("zip_too_large", "ZIP content exceeds the decompression limit");
    }
    throw new CollectionError("invalid_zip", "Malformed ZIP archive");
  }
}

function read(buf: Buffer, limits: ZipLimits, accept: (name: string) => boolean): ZipFile[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CollectionError("invalid_zip", "ZIP central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > limits.maxEntries) throw new CollectionError("zip_too_large", `ZIP has more than ${limits.maxEntries} entries`);
  let off = buf.readUInt32LE(eocd + 16);
  const files: ZipFile[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new CollectionError("invalid_zip", "Bad central directory entry");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const next = off + 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off = next;
    if (name.endsWith("/") || !accept(name)) continue;
    if (flags & 1) throw new CollectionError("invalid_zip", "Encrypted ZIP entries are not supported");
    if (csize === 0xffffffff || usize === 0xffffffff) throw new CollectionError("invalid_zip", "ZIP64 is not supported");
    if (usize > limits.maxEntryBytes) throw new CollectionError("zip_too_large", `ZIP entry exceeds ${limits.maxEntryBytes} bytes`);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new CollectionError("invalid_zip", "Bad local header");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new CollectionError("invalid_zip", "Truncated ZIP entry");
    const comp = buf.subarray(start, start + csize);
    const room = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
    if (room < 1 && comp.length > 0) throw new CollectionError("zip_too_large", "ZIP total size limit reached");
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp, { maxOutputLength: Math.max(1, room) });
    else throw new CollectionError("invalid_zip", `Unsupported ZIP method ${method}`);
    if (data.length > room) throw new CollectionError("zip_too_large", "ZIP content exceeds the decompression limit");
    total += data.length;
    files.push({ name, data });
  }
  return files;
}
