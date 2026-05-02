import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const size = 32;
const maskRowSize = Math.ceil(size / 32) * 4;
const pixelBytes = size * size * 4;
const maskBytes = maskRowSize * size;
const imageBytes = 40 + pixelBytes + maskBytes;
const fileBytes = 6 + 16 + imageBytes;
const output = resolve(import.meta.dirname, "../src-tauri/icons/icon.ico");

const buffer = Buffer.alloc(fileBytes);
let offset = 0;

buffer.writeUInt16LE(0, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;

buffer.writeUInt8(size, offset++);
buffer.writeUInt8(size, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(imageBytes, offset);
offset += 4;
buffer.writeUInt32LE(22, offset);
offset += 4;

buffer.writeUInt32LE(40, offset);
offset += 4;
buffer.writeInt32LE(size, offset);
offset += 4;
buffer.writeInt32LE(size * 2, offset);
offset += 4;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(pixelBytes, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;

for (let y = size - 1; y >= 0; y -= 1) {
  for (let x = 0; x < size; x += 1) {
    const inSlash = Math.abs(x - (size - y - 6)) < 3;
    const inP = x >= 7 && x <= 17 && y >= 7 && y <= 22 && (x <= 10 || y <= 10 || y >= 15 || x >= 15);
    const inFiveTop = x >= 18 && x <= 25 && y >= 8 && y <= 11;
    const inFiveMid = x >= 18 && x <= 25 && y >= 15 && y <= 18;
    const inFiveBot = x >= 18 && x <= 25 && y >= 22 && y <= 25;
    const inFiveLeft = x >= 18 && x <= 21 && y >= 8 && y <= 18;
    const inFiveRight = x >= 22 && x <= 25 && y >= 15 && y <= 25;
    const white = inP || inFiveTop || inFiveMid || inFiveBot || inFiveLeft || inFiveRight;

    let r = 229;
    let g = 9;
    let b = 20;
    if (inSlash) {
      r = 16;
      g = 16;
      b = 18;
    }
    if (white) {
      r = 255;
      g = 255;
      b = 255;
    }

    buffer.writeUInt8(b, offset++);
    buffer.writeUInt8(g, offset++);
    buffer.writeUInt8(r, offset++);
    buffer.writeUInt8(255, offset++);
  }
}

offset += maskBytes;
mkdirSync(resolve(import.meta.dirname, "../src-tauri/icons"), { recursive: true });
writeFileSync(output, buffer);
console.log(output);
