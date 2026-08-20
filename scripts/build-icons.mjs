import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const iconsRoot = path.join(repositoryRoot, "resources", "icons");
const pngRoot = path.join(iconsRoot, "png");

await Promise.all([buildIcns(), buildIco()]);

async function buildIcns() {
  const entries = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ];
  const chunks = await Promise.all(
    entries.map(async ([type, size]) => {
      const png = await readFile(path.join(pngRoot, `icon-${size}.png`));
      const header = Buffer.alloc(8);
      header.write(type, 0, 4, "ascii");
      header.writeUInt32BE(png.length + header.length, 4);
      return Buffer.concat([header, png]);
    }),
  );
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + header.length, 4);
  await writeFile(path.join(iconsRoot, "geminui.icns"), Buffer.concat([header, body]));
}

async function buildIco() {
  const sizes = [16, 32, 64, 128, 256];
  const images = await Promise.all(
    sizes.map((size) => readFile(path.join(pngRoot, `icon-${size}.png`))),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = header.length + images.length * 16;
  const directory = Buffer.concat(
    images.map((image, index) => {
      const size = sizes[index];
      const entry = Buffer.alloc(16);
      entry.writeUInt8(size === 256 ? 0 : size, 0);
      entry.writeUInt8(size === 256 ? 0 : size, 1);
      entry.writeUInt8(0, 2);
      entry.writeUInt8(0, 3);
      entry.writeUInt16LE(1, 4);
      entry.writeUInt16LE(32, 6);
      entry.writeUInt32LE(image.length, 8);
      entry.writeUInt32LE(imageOffset, 12);
      imageOffset += image.length;
      return entry;
    }),
  );
  await writeFile(
    path.join(iconsRoot, "geminui.ico"),
    Buffer.concat([header, directory, ...images]),
  );
}
