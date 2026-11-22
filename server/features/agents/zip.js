import { deflateRawSync } from "node:zlib";
import { crc32 } from "../chat/downloads.js";
import { requireSafePath } from "./artifacts.js";

function dosDateTime(date = new Date()) {
  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  const day =
    (Math.max(0, date.getUTCFullYear() - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  return { time, day };
}

// Minimal ZIP writer that keeps folder structure (the legacy chat ZIP flattens names)
// and deflate-compresses entries. Paths are validated: no absolute paths, no "..".
export function buildZip(files, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const local = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const path = requireSafePath(file.path);
    const name = Buffer.from(path, "utf8");
    const raw = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content), "utf8");
    const packed = deflateRawSync(raw, { level: 6 });
    const useDeflate = packed.length < raw.length;
    const data = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
