// Minimal streaming ZIP writer — STORE method (no compression), with data
// descriptors so files can be streamed without a two-pass read. Zero deps.
// Media files barely compress, so "store" keeps it fast and simple.

import fs from "node:fs";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Push(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return c >>> 0;
}

/**
 * Stream a list of files into `out` as a ZIP archive.
 * @param {{name: string, path: string}[]} files
 * @param {import('node:stream').Writable} out
 * @returns {Promise<void>}
 */
export function createZip(files, out) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const central = [];

    const write = (buf) =>
      new Promise((res, rej) => {
        offset += buf.length;
        out.write(buf, (err) => (err ? rej(err) : res()));
      });

    async function addFile({ name, path: filePath }) {
      const nameBuf = Buffer.from(name, "utf8");
      const localHeaderOffset = offset;

      // local file header (crc/sizes are zero; real values go in descriptor)
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // signature
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0808, 6); // flags: bit3 data descriptor + bit11 utf8
      local.writeUInt16LE(0, 8); // method = store
      local.writeUInt16LE(0, 10); // mod time
      local.writeUInt16LE(0, 12); // mod date
      local.writeUInt32LE(0, 14); // crc32 (later)
      local.writeUInt32LE(0, 18); // comp size (later)
      local.writeUInt32LE(0, 22); // uncomp size (later)
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // extra len
      await write(local);
      await write(nameBuf);

      // stream the file body, tracking crc + size
      let crc = 0xffffffff;
      let size = 0;
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(filePath);
        rs.on("data", (chunk) => {
          crc = crc32Push(crc, chunk);
          size += chunk.length;
          offset += chunk.length;
          if (!out.write(chunk)) {
            rs.pause();
            out.once("drain", () => rs.resume());
          }
        });
        rs.on("end", res);
        rs.on("error", rej);
      });
      crc = (crc ^ 0xffffffff) >>> 0;

      // data descriptor
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0); // descriptor signature
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(size, 8); // comp size
      desc.writeUInt32LE(size, 12); // uncomp size
      await write(desc);

      central.push({ name: nameBuf, crc, size, localHeaderOffset });
    }

    (async () => {
      try {
        for (const f of files) await addFile(f);

        // central directory
        const cdStart = offset;
        for (const e of central) {
          const cd = Buffer.alloc(46);
          cd.writeUInt32LE(0x02014b50, 0); // signature
          cd.writeUInt16LE(20, 4); // version made by
          cd.writeUInt16LE(20, 6); // version needed
          cd.writeUInt16LE(0x0808, 8); // flags
          cd.writeUInt16LE(0, 10); // method
          cd.writeUInt16LE(0, 12); // mod time
          cd.writeUInt16LE(0, 14); // mod date
          cd.writeUInt32LE(e.crc, 16);
          cd.writeUInt32LE(e.size, 20);
          cd.writeUInt32LE(e.size, 24);
          cd.writeUInt16LE(e.name.length, 28);
          cd.writeUInt16LE(0, 30); // extra len
          cd.writeUInt16LE(0, 32); // comment len
          cd.writeUInt16LE(0, 34); // disk start
          cd.writeUInt16LE(0, 36); // internal attrs
          cd.writeUInt32LE(0, 38); // external attrs
          cd.writeUInt32LE(e.localHeaderOffset, 42);
          await write(cd);
          await write(e.name);
        }
        const cdSize = offset - cdStart;

        // end of central directory
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); // disk
        eocd.writeUInt16LE(0, 6); // cd disk
        eocd.writeUInt16LE(central.length, 8);
        eocd.writeUInt16LE(central.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20); // comment len
        await write(eocd);

        out.end(() => resolve());
      } catch (err) {
        reject(err);
      }
    })();
  });
}
