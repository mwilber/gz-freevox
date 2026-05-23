import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const outDir = new URL('../public/icons/', import.meta.url);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(width, height, maskable = false) {
  const rows = [];
  const cx = width / 2;
  const cy = height / 2;
  const radius = width * (maskable ? 0.36 : 0.42);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const inDisc = distance < radius;
      const inBar = Math.abs(x - cx) < width * 0.055 && Math.abs(y - cy) < height * 0.25;
      const inRing = Math.abs(distance - radius * 0.58) < width * 0.035 && y < cy + height * 0.05;
      const offset = 1 + x * 4;
      if (inBar || inRing) {
        row[offset] = 255;
        row[offset + 1] = 255;
        row[offset + 2] = 255;
        row[offset + 3] = 255;
      } else if (inDisc) {
        row[offset] = 18;
        row[offset + 1] = 85;
        row[offset + 2] = 79;
        row[offset + 3] = 255;
      } else {
        row[offset] = 238;
        row[offset + 1] = 243;
        row[offset + 2] = 241;
        row[offset + 3] = 255;
      }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

await mkdir(outDir, { recursive: true });
await writeFile(new URL('icon-192.png', outDir), png(192, 192));
await writeFile(new URL('icon-512.png', outDir), png(512, 512));
await writeFile(new URL('maskable-512.png', outDir), png(512, 512, true));
