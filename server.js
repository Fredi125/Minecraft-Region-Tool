const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");
const zlib = require("zlib");

const app = express();
const PORT = 25599;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Minecraft version constants ───────────────────────────────────────────────
// DataVersion values at which coordinate behaviour changed
const DV_1_17 = 2730;   // 1.17 — intermediate (for reference)

// Known DataVersion → human label map (representative releases)
const DATA_VERSION_LABELS = {
  1343: "1.12.2", 1519: "1.13", 1628: "1.14", 2225: "1.15", 2566: "1.16.5",
  2724: "1.17", 2730: "1.17.1", 2825: "1.18", 2860: "1.18.2",
  3105: "1.19", 3218: "1.19.4", 3337: "1.20", 3465: "1.20.4",
  3578: "1.20.6", 3698: "1.21", 3837: "1.21.4",
};

function labelForDataVersion(dv) {
  if (!dv) return "Unknown";
  // Find the closest known version that is <= dv
  const known = Object.keys(DATA_VERSION_LABELS).map(Number).sort((a,b)=>a-b);
  let label = null;
  for (const k of known) {
    if (dv >= k) label = DATA_VERSION_LABELS[k];
  }
  if (!label) return `DataVersion ${dv}`;
  // If exact match just return it, otherwise add a + to show it's newer
  const exactKey = known.find(k => DATA_VERSION_LABELS[k] === label);
  return dv === exactKey ? label : `~${label}+`;
}

// ── Minimal NBT reader — just enough to extract DataVersion from level.dat ────
// level.dat is gzip-compressed NBT. We only need the root compound's
// "Data" compound's "DataVersion" integer tag. Full NBT spec:
//   TAG_End=0, TAG_Byte=1, TAG_Short=2, TAG_Int=3, TAG_Long=4,
//   TAG_Float=5, TAG_Double=6, TAG_ByteArray=7, TAG_String=8,
//   TAG_List=9, TAG_Compound=10, TAG_IntArray=11, TAG_LongArray=12
function readNbtDataVersion(buf) {
  let pos = 0;

  function readU8()  { return buf[pos++]; }
  function readI16() { const v = buf.readInt16BE(pos); pos += 2; return v; }
  function readI32() { const v = buf.readInt32BE(pos); pos += 4; return v; }
  function readI64() { pos += 8; return null; }   // skip, don't need value
  function readStr() { const len = (readU8() << 8) | readU8(); const s = buf.slice(pos, pos + len).toString("utf8"); pos += len; return s; }

  function skipPayload(type) {
    switch (type) {
      case 1: pos += 1; break;                  // byte
      case 2: pos += 2; break;                  // short
      case 3: pos += 4; break;                  // int
      case 4: pos += 8; break;                  // long
      case 5: pos += 4; break;                  // float
      case 6: pos += 8; break;                  // double
      case 7: { const n = readI32(); pos += n; break; }   // byte[]
      case 8: { const n = (readU8() << 8) | readU8(); pos += n; break; } // string
      case 9: { const et = readU8(); const n = readI32(); for (let i=0;i<n;i++) skipPayload(et); break; } // list
      case 10: skipCompound(); break;           // compound
      case 11: { const n = readI32(); pos += n*4; break; }  // int[]
      case 12: { const n = readI32(); pos += n*8; break; }  // long[]
      default: throw new Error("Unknown NBT tag type: " + type);
    }
  }

  // Returns an object of { name: value } for INT tags, recurses into compounds
  function readCompound() {
    const result = {};
    while (pos < buf.length) {
      const type = readU8();
      if (type === 0) break; // TAG_End
      const name = readStr();
      if (type === 3) {          // TAG_Int — capture it
        result[name] = readI32();
      } else if (type === 10) {  // TAG_Compound — recurse
        result[name] = readCompound();
      } else {
        skipPayload(type);
      }
    }
    return result;
  }

  function skipCompound() {
    while (pos < buf.length) {
      const type = readU8();
      if (type === 0) break;
      const nameLen = (readU8() << 8) | readU8();
      pos += nameLen;
      skipPayload(type);
    }
  }

  // Root tag is always a TAG_Compound with a 2-byte name length
  const rootType = readU8();
  if (rootType !== 10) throw new Error("Root NBT tag is not a compound");
  readStr(); // root name (usually empty)
  const root = readCompound();

  // DataVersion is either at root level or under root.Data
  const dv = root["DataVersion"] ?? root["Data"]?.["DataVersion"] ?? null;
  return dv;
}

// ── Read DataVersion from a world's level.dat ─────────────────────────────────
function readWorldDataVersion(worldDir) {
  const levelDat = path.join(worldDir, "level.dat");
  if (!fs.existsSync(levelDat)) return null;
  try {
    const compressed = fs.readFileSync(levelDat);
    const raw = zlib.gunzipSync(compressed);
    return readNbtDataVersion(raw);
  } catch (e) {
    return null;
  }
}


// ── Native folder picker ──────────────────────────────────────────────────────
// Tracks the last browsed folder for the lifetime of the server process so
// that every dialog opens where the user last left off.
let lastBrowsedDir = null;

app.get("/api/browse", (req, res) => {
  const platform = os.platform();
  // Use caller-supplied hint, then last-browsed, then home directory
  const startDir = req.query.startPath || lastBrowsedDir || os.homedir();
  let selectedPath = null;
  try {
    if (platform === "win32") {
      // SelectedPath pre-seeds the dialog's initial directory
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select a Minecraft world region folder'; $f.SelectedPath = '${startDir.replace(/'/g, "''")}'; $f.ShowDialog() | Out-Null; Write-Output $f.SelectedPath`;
      selectedPath = execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 60000 }).toString().trim();
    } else if (platform === "darwin") {
      const appleStart = startDir.replace(/'/g, "\'");
      selectedPath = execSync(`osascript -e 'POSIX path of (choose folder with prompt "Select region folder" default location POSIX file "${appleStart}")'`, { timeout: 60000 }).toString().trim().replace(/\/$/, "");
    } else {
      try {
        selectedPath = execSync(`zenity --file-selection --directory --title='Select region folder' --filename='${startDir.replace(/'/g, "\'")}'`, { timeout: 60000 }).toString().trim();
      } catch {
        selectedPath = execSync(`kdialog --getexistingdirectory '${startDir.replace(/'/g, "\'")}'`, { timeout: 60000 }).toString().trim();
      }
    }
  } catch {
    return res.status(500).json({ error: "Dialog cancelled or unavailable." });
  }
  if (!selectedPath) return res.status(400).json({ error: "No folder selected." });
  // Remember this location for next time
  lastBrowsedDir = selectedPath;
  res.json({ path: selectedPath });
});

// ── Scan folder for .mca files ───────────────────────────────────────────────
app.get("/api/scan", (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: "No path provided." });
  try {
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: "Not a directory." });
  } catch {
    return res.status(400).json({ error: "Directory not found." });
  }
  const files = fs.readdirSync(dir).filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f));
  if (!files.length) return res.status(400).json({ error: "No .mca region files found in this folder." });
  const regions = files.map(f => {
    const m = f.match(/^r\.([-\d]+)\.([-\d]+)\.mca$/);
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    return { file: f, x: parseInt(m[1]), z: parseInt(m[2]), sizeBytes: st.size, mtime: st.mtimeMs };
  });
  res.json({ dir, regions, count: regions.length });
});

// ── Pre-flight conflict detection ─────────────────────────────────────────────
app.post("/api/preflight", (req, res) => {
  const { worlds, destDir } = req.body;
  if (!worlds || !worlds.length) return res.status(400).json({ error: "No worlds provided." });

  // Helper: derive sibling dir path for entities/poi from the region destDir
  function siblingDestDir(subfolder) {
    if (!subfolder || subfolder === 'region') return destDir;
    if (!destDir) return null;
    const d = destDir.replace(/([\/\\])region([\/\\]?)$/, '$1' + subfolder + '$2');
    return d !== destDir ? d : destDir.replace(/region$/, subfolder);
  }

  // Build destMap keyed by "subfolder:destFile" so region/entities/poi never
  // conflict with each other even when they share the same filename.
  const destMap = {};
  for (const world of worlds) {
    for (const region of world.regions) {
      const subfolder = region.destSubType || 'region';
      const srcDir = region.srcDir || world.dir;
      const destFile = `r.${region.x + world.ox}.${region.z + world.oz}.mca`;
      const key = `${subfolder}:${destFile}`;
      if (!destMap[key]) destMap[key] = { subfolder, destFile, srcDir: null, options: [] };
      destMap[key].srcDir = destMap[key].srcDir || srcDir;
      destMap[key].options.push({
        worldId: world.id,
        worldName: world.name,
        srcDir,
        srcFile: region.file,
        sizeBytes: region.sizeBytes || 0,
        mtime: region.mtime || 0,
        isExisting: false,
        destSubType: subfolder !== 'region' ? subfolder : undefined,
      });
    }
  }

  // Detect already-existing files in each destination subfolder
  function getExisting(subfolder) {
    const dir = siblingDestDir(subfolder);
    const existing = {};
    if (!dir) return existing;
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        fs.readdirSync(dir)
          .filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f))
          .forEach(f => {
            try {
              const st = fs.statSync(path.join(dir, f));
              existing[f] = { sizeBytes: st.size, mtime: st.mtimeMs };
            } catch {}
          });
      }
    } catch {}
    return existing;
  }
  const existingBySubfolder = {};
  const subfolders = [...new Set(Object.values(destMap).map(e => e.subfolder))];
  for (const sf of subfolders) existingBySubfolder[sf] = getExisting(sf);

  const conflicts = [];
  const clean = [];

  for (const { subfolder, destFile, options: srcOptions } of Object.values(destMap)) {
    const existingInDest = existingBySubfolder[subfolder] || {};
    const existing = existingInDest[destFile];
    const allOptions = [...srcOptions];
    const destSubDir = siblingDestDir(subfolder);

    if (existing) {
      allOptions.unshift({
        worldId: null,
        worldName: "Existing file",
        srcDir: destSubDir,
        srcFile: destFile,
        sizeBytes: existing.sizeBytes,
        mtime: existing.mtime,
        isExisting: true,
        destSubType: subfolder !== 'region' ? subfolder : undefined,
      });
    }

    if (allOptions.length >= 2) {
      const type = srcOptions.length >= 2 ? "world" : "dest";
      conflicts.push({ destFile, subfolder, type, options: allOptions,
        destSubType: subfolder !== 'region' ? subfolder : undefined });
    } else {
      clean.push({ destFile, subfolder, srcDir: srcOptions[0].srcDir, srcFile: srcOptions[0].srcFile,
        worldName: srcOptions[0].worldName,
        destSubType: subfolder !== 'region' ? subfolder : undefined });
    }
  }

  res.json({
    conflicts, clean,
    totalFiles: clean.length + conflicts.length,
    worldConflicts: conflicts.filter(c => c.type === "world").length,
    destConflicts: conflicts.filter(c => c.type === "dest").length,
  });
});


// ── MCA chunk NBT coordinate patcher ─────────────────────────────────────────
//
// Each .mca file is a region file containing up to 32×32 = 1024 chunks.
// Each chunk's NBT data has xPos and zPos fields baked in at save time.
// When we rename/copy a region file to a new location (r.A.B.mca → r.X.Z.mca),
// those stored coords no longer match what Minecraft expects for that file.
// Since 1.18, Minecraft validates these on load and rejects mismatched chunks.
//
// This function reads every chunk from the MCA file, patches xPos and zPos
// to match the correct region position, and writes a corrected copy.
//
// MCA format:
//   Bytes 0–4095:   Location table  (1024 × 4-byte entries)
//                   entry[x + z*32]: [offset_hi, offset_mid, offset_lo, sectorCount]
//                   offset is in 4096-byte sectors from start of file
//   Bytes 4096–8191: Timestamp table (1024 × 4-byte entries, preserved as-is)
//   Bytes 8192+:    Chunk data, each aligned to 4096-byte sector boundaries
//                   4 bytes: length (includes compression byte)
//                   1 byte:  compression (1=gzip, 2=zlib, 3=raw)
//                   N bytes: compressed NBT

function patchNbtInts(buf, patches) {
  // Scans a raw NBT buffer and patches specific TAG_Int (type 3) fields by name.
  // patches = { xPos: number, zPos: number }
  // Modifies a copy of buf in place and returns it.
  const result = Buffer.from(buf);
  let pos = 0;

  function ru8()  { return result[pos++]; }
  function ri16() { const v = result.readInt16BE(pos); pos += 2; return v; }
  function ri32() { const v = result.readInt32BE(pos); pos += 4; return v; }
  function rstr() { const len = (ru8() << 8) | ru8(); pos += len; }
  function strName() {
    const len = (result[pos] << 8) | result[pos+1]; pos += 2;
    const name = result.slice(pos, pos+len).toString("utf8"); pos += len;
    return name;
  }

  function skipPayload(type) {
    switch (type) {
      case 1: pos += 1; break;
      case 2: pos += 2; break;
      case 3: pos += 4; break;
      case 4: pos += 8; break;
      case 5: pos += 4; break;
      case 6: pos += 8; break;
      case 7:  { const n = result.readInt32BE(pos); pos += 4 + n; break; }
      case 8:  { const n = (ru8() << 8) | ru8(); pos += n; break; }
      case 9:  { const et = ru8(); const n = result.readInt32BE(pos); pos += 4; for (let i = 0; i < n; i++) skipPayload(et); break; }
      case 10: readCompound(); break;
      case 11: { const n = result.readInt32BE(pos); pos += 4 + n * 4; break; }
      case 12: { const n = result.readInt32BE(pos); pos += 4 + n * 8; break; }
      default: break;
    }
  }

  function readCompound() {
    while (pos < result.length) {
      const type = ru8();
      if (type === 0) break; // TAG_End
      const name = strName();
      if (type === 3) { // TAG_Int — patch if it's xPos or zPos
        if (patches[name] !== undefined) {
          result.writeInt32BE(patches[name], pos);
        }
        pos += 4;
      } else if (type === 10) {
        readCompound(); // recurse into sub-compounds (handles both old and new chunk format)
      } else {
        skipPayload(type);
      }
    }
  }

  try {
    const rootType = ru8();
    if (rootType !== 10) return buf;
    const rootNameLen = (ru8() << 8) | ru8();
    pos += rootNameLen;
    readCompound();
  } catch { return buf; }
  return result;
}

function patchMcaFile(srcPath, destPath, regionX, regionZ) {
  const src = fs.readFileSync(srcPath);
  const SECTOR = 4096;

  // Read location table
  const locations = [];
  for (let i = 0; i < 1024; i++) {
    const base = i * 4;
    const offset = (src[base] << 16) | (src[base+1] << 8) | src[base+2];
    const sectors = src[base+3];
    locations.push({ offset, sectors });
  }

  // Timestamps (preserve original)
  const timestamps = src.slice(4096, 8192);

  // Process each chunk slot
  const patchedChunks = new Map(); // idx → { compression, data: Buffer }
  let chunksTotal = 0, chunksPatched = 0;

  for (let localZ = 0; localZ < 32; localZ++) {
    for (let localX = 0; localX < 32; localX++) {
      const idx = localX + localZ * 32;
      const { offset, sectors } = locations[idx];
      if (offset === 0 && sectors === 0) continue; // empty slot

      const byteOffset = offset * SECTOR;
      if (byteOffset + 5 > src.length) continue; // corrupt entry

      const dataLen = src.readUInt32BE(byteOffset);       // includes compression byte
      const compression = src[byteOffset + 4];
      const compressedData = src.slice(byteOffset + 5, byteOffset + 4 + dataLen);

      chunksTotal++;

      try {
        // Decompress
        let nbt;
        if (compression === 1)      nbt = zlib.gunzipSync(compressedData);
        else if (compression === 2) nbt = zlib.inflateSync(compressedData);
        else if (compression === 3) nbt = compressedData;
        else { patchedChunks.set(idx, { compression, data: compressedData }); continue; } // LZ4 etc.

        // Patch xPos and zPos
        const correctX = regionX * 32 + localX;
        const correctZ = regionZ * 32 + localZ;
        const patched = patchNbtInts(nbt, { xPos: correctX, zPos: correctZ });

        // Recompress
        let recompressed;
        if (compression === 1)      recompressed = zlib.gzipSync(patched);
        else if (compression === 2) recompressed = zlib.deflateSync(patched);
        else                        recompressed = patched;

        patchedChunks.set(idx, { compression, data: recompressed });
        chunksPatched++;
      } catch {
        // If patching fails, preserve original chunk data
        patchedChunks.set(idx, { compression, data: compressedData });
      }
    }
  }

  // Reconstruct MCA file with updated location table
  const newLocationTable = Buffer.alloc(4096, 0);
  const chunkSectors = [];
  let currentSector = 2; // sectors 0 and 1 = header

  for (let localZ = 0; localZ < 32; localZ++) {
    for (let localX = 0; localX < 32; localX++) {
      const idx = localX + localZ * 32;
      const chunk = patchedChunks.get(idx);
      if (!chunk) continue;

      // Build chunk payload: 4-byte length + 1-byte compression + data
      const payload = Buffer.alloc(5 + chunk.data.length);
      payload.writeUInt32BE(1 + chunk.data.length, 0);
      payload[4] = chunk.compression;
      chunk.data.copy(payload, 5);

      // Pad to sector boundary
      const sectorCount = Math.ceil(payload.length / SECTOR);
      const padded = Buffer.alloc(sectorCount * SECTOR, 0);
      payload.copy(padded);

      // Update location table entry
      const base = idx * 4;
      newLocationTable[base]   = (currentSector >> 16) & 0xFF;
      newLocationTable[base+1] = (currentSector >> 8) & 0xFF;
      newLocationTable[base+2] = currentSector & 0xFF;
      newLocationTable[base+3] = sectorCount;

      chunkSectors.push(padded);
      currentSector += sectorCount;
    }
  }

  const out = Buffer.concat([newLocationTable, timestamps, ...chunkSectors]);
  fs.writeFileSync(destPath, out);
  return { chunksTotal, chunksPatched };
}



// ── Entity MCA coordinate translator ─────────────────────────────────────────
//
// Entity region files (.mca in entities/) store entities at absolute world-space
// positions in a Pos:[x,y,z] double list. When we rename r.A.B.mca → r.X.Z.mca,
// those positions must be translated by the block offset, otherwise Minecraft
// discards entities whose Pos doesn't match the chunk they're stored in.
//
// Entity NBT root structure:
//   Position: TAG_INT_ARRAY [chunkX, chunkZ]  ← chunk coords, must match file
//   Entities: TAG_LIST of TAG_COMPOUND          ← one compound per entity
//     Pos:  TAG_LIST of 3 TAG_DOUBLE [x, y, z] ← absolute world position
//     Passengers: TAG_LIST of TAG_COMPOUND      ← recursive (boats+riders etc.)

function patchEntityNbt(buf, dx, dz) {
  // dx, dz = block-coordinate offset to add to all positions
  const result = Buffer.from(buf);
  let pos = 0;

  function skipStr() {
    const len = (result[pos] << 8) | result[pos+1]; pos += 2 + len;
  }
  function readStr() {
    const len = (result[pos] << 8) | result[pos+1]; pos += 2;
    const s = result.slice(pos, pos+len).toString('utf8'); pos += len; return s;
  }
  function skipPayload(type) {
    switch(type) {
      case 1: pos += 1; break;
      case 2: pos += 2; break;
      case 3: pos += 4; break;
      case 4: pos += 8; break;
      case 5: pos += 4; break;
      case 6: pos += 8; break;
      case 7: { const n = result.readInt32BE(pos); pos += 4 + n; break; }
      case 8: skipStr(); break;
      case 9: { const et = result[pos++]; const n = result.readInt32BE(pos); pos += 4; for(let i=0;i<n;i++) skipPayload(et); break; }
      case 10: skipCompound(); break;
      case 11: { const n = result.readInt32BE(pos); pos += 4 + n*4; break; }
      case 12: { const n = result.readInt32BE(pos); pos += 4 + n*8; break; }
    }
  }
  function skipCompound() {
    while(pos < result.length) { const t = result[pos++]; if(t===0) break; skipStr(); skipPayload(t); }
  }

  // Patch one entity compound: translate Pos, recurse into Passengers
  function patchEntity() {
    while(pos < result.length) {
      const type = result[pos++];
      if(type === 0) break;
      const name = readStr();
      if(type === 9 && name === 'Pos') {
        const et = result[pos++];
        const n = result.readInt32BE(pos); pos += 4;
        if(et === 6 && n >= 3) {
          // x += dx
          result.writeDoubleBE(result.readDoubleBE(pos) + dx, pos); pos += 8;
          pos += 8; // y unchanged
          // z += dz
          result.writeDoubleBE(result.readDoubleBE(pos) + dz, pos); pos += 8;
          pos += (n - 3) * 8; // skip extra doubles if any
        } else {
          for(let i=0;i<n;i++) skipPayload(et);
        }
      } else if(type === 9 && name === 'Passengers') {
        // Passengers are entities too — recurse
        const et = result[pos++];
        const n = result.readInt32BE(pos); pos += 4;
        if(et === 10) { for(let i=0;i<n;i++) patchEntity(); }
        else { for(let i=0;i<n;i++) skipPayload(et); }
      } else {
        skipPayload(type);
      }
    }
  }

  try {
    const rootType = result[pos++];
    if(rootType !== 10) return buf; // not a compound, bail
    skipStr(); // root name (empty string)

    while(pos < result.length) {
      const type = result[pos++];
      if(type === 0) break;
      const name = readStr();
      if(type === 11 && name === 'Position') {
        // TAG_INT_ARRAY [chunkX, chunkZ] — update to new chunk coordinates
        const n = result.readInt32BE(pos); pos += 4;
        if(n >= 2) {
          result.writeInt32BE(result.readInt32BE(pos)   + Math.trunc(dx / 16), pos);
          result.writeInt32BE(result.readInt32BE(pos+4) + Math.trunc(dz / 16), pos + 4);
        }
        pos += n * 4;
      } else if(type === 9 && name === 'Entities') {
        const et = result[pos++];
        const n = result.readInt32BE(pos); pos += 4;
        if(et === 10) { for(let i=0;i<n;i++) patchEntity(); }
        else { for(let i=0;i<n;i++) skipPayload(et); }
      } else {
        skipPayload(type);
      }
    }
  } catch { return buf; } // on any parse error, return original

  return result;
}

function patchEntityMcaFile(srcPath, dstPath, srcRX, srcRZ, dstRX, dstRZ) {
  const src = fs.readFileSync(srcPath);
  const SECTOR = 4096;
  const dx = (dstRX - srcRX) * 512; // block offset X (1 region = 32 chunks * 16 blocks)
  const dz = (dstRZ - srcRZ) * 512; // block offset Z

  // Parse location table
  const locations = [];
  for(let i = 0; i < 1024; i++) {
    const base = i * 4;
    const offset = (src[base] << 16) | (src[base+1] << 8) | src[base+2];
    const sectors = src[base+3];
    locations.push({ offset, sectors });
  }

  const timestamps = src.slice(4096, 8192);
  const patchedChunks = new Map();

  for(let localZ = 0; localZ < 32; localZ++) {
    for(let localX = 0; localX < 32; localX++) {
      const idx = localX + localZ * 32;
      const { offset, sectors } = locations[idx];
      if(offset === 0 && sectors === 0) continue;
      const byteOffset = offset * SECTOR;
      if(byteOffset + 5 > src.length) continue;

      const dataLen = src.readUInt32BE(byteOffset);
      const compression = src[byteOffset + 4];
      const compressedData = src.slice(byteOffset + 5, byteOffset + 4 + dataLen);

      try {
        let nbt;
        if(compression === 1)      nbt = zlib.gunzipSync(compressedData);
        else if(compression === 2) nbt = zlib.inflateSync(compressedData);
        else if(compression === 3) nbt = compressedData;
        else { patchedChunks.set(idx, { compression, data: compressedData }); continue; }

        const patched = patchEntityNbt(nbt, dx, dz);

        let recompressed;
        if(compression === 1)      recompressed = zlib.gzipSync(patched);
        else if(compression === 2) recompressed = zlib.deflateSync(patched);
        else                       recompressed = patched;

        patchedChunks.set(idx, { compression, data: recompressed });
      } catch {
        patchedChunks.set(idx, { compression, data: compressedData });
      }
    }
  }

  // Reconstruct MCA file
  const newLocationTable = Buffer.alloc(4096, 0);
  const chunkSectors = [];
  let currentSector = 2;

  for(let localZ = 0; localZ < 32; localZ++) {
    for(let localX = 0; localX < 32; localX++) {
      const idx = localX + localZ * 32;
      const chunk = patchedChunks.get(idx);
      if(!chunk) continue;

      const payload = Buffer.alloc(5 + chunk.data.length);
      payload.writeUInt32BE(1 + chunk.data.length, 0);
      payload[4] = chunk.compression;
      chunk.data.copy(payload, 5);

      const sectorCount = Math.ceil(payload.length / SECTOR);
      const padded = Buffer.alloc(sectorCount * SECTOR, 0);
      payload.copy(padded);

      const base = idx * 4;
      newLocationTable[base]   = (currentSector >> 16) & 0xFF;
      newLocationTable[base+1] = (currentSector >> 8) & 0xFF;
      newLocationTable[base+2] = currentSector & 0xFF;
      newLocationTable[base+3] = sectorCount;

      chunkSectors.push(padded);
      currentSector += sectorCount;
    }
  }

  fs.writeFileSync(dstPath, Buffer.concat([newLocationTable, timestamps, ...chunkSectors]));
}

// ── Execute copy operations ───────────────────────────────────────────────────
// Each op: { from, to, srcDir, keepExisting?, needsNbtPatch? }
// needsNbtPatch is always true — coordinates are corrected for all imports.
app.post("/api/execute", (req, res) => {
  const { ops, destDir } = req.body;
  if (!ops || !ops.length) return res.status(400).json({ error: "No operations provided." });
  if (!destDir) return res.status(400).json({ error: "No destination directory." });

  try { fs.mkdirSync(destDir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: `Could not create destination: ${e.message}` }); }

  const results = [];
  let errors = 0, keptExisting = 0, nbtPatched = 0;

  for (const op of ops) {
    if (op.keepExisting) {
      results.push({ file: op.to, ok: true, kept: true });
      keptExisting++;
      continue;
    }
    // Use explicit destDir from op if provided (set by client for entities/poi),
    // otherwise derive from op.subfolder, otherwise fall back to destDir (region).
    const effectiveDest = op.destDir ||
      ((op.subfolder && op.subfolder !== 'region')
        ? destDir.replace(/([\/\\])region([\/\\]?)$/, '$1' + op.subfolder + '$2').replace(/region$/, op.subfolder)
        : destDir);
    try { require('fs').mkdirSync(effectiveDest, { recursive: true }); } catch {}
    const src = path.join(op.srcDir, op.from);
    const dst = path.join(effectiveDest, op.to);
    try {
      if (op.needsNbtPatch) {
        const mDst = op.to.match(/^r\.([-\d]+)\.([-\d]+)\.mca$/);
        if (mDst) {
          const dstRX = parseInt(mDst[1]), dstRZ = parseInt(mDst[2]);
          if (op.subfolder === 'entities') {
            // Entity files: translate entity Pos by block offset, update Position chunk tag
            const mSrc = op.from.match(/^r\.([-\d]+)\.([-\d]+)\.mca$/);
            if (mSrc) {
              patchEntityMcaFile(src, dst, parseInt(mSrc[1]), parseInt(mSrc[2]), dstRX, dstRZ);
              results.push({ file: op.to, ok: true, entityPatched: true });
            } else {
              fs.copyFileSync(src, dst);
              results.push({ file: op.to, ok: true });
            }
          } else {
            // Region files: patch xPos/zPos in chunk NBT
            const { chunksTotal, chunksPatched } = patchMcaFile(src, dst, dstRX, dstRZ);
            results.push({ file: op.to, ok: true, nbtPatched: true, chunksPatched, chunksTotal });
            nbtPatched++;
          }
        } else {
          fs.copyFileSync(src, dst);
          results.push({ file: op.to, ok: true });
        }
      } else {
        fs.copyFileSync(src, dst);
        results.push({ file: op.to, ok: true });
      }
    } catch (e) {
      results.push({ file: op.to, ok: false, error: e.message });
      errors++;
    }
  }

  res.json({ done: results.length, errors, keptExisting, nbtPatched, results });
});

// ── Open folder in OS file explorer ──────────────────────────────────────────
app.post("/api/open-folder", (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: "No dir." });
  try {
    const p = os.platform();
    if (p === "win32") execSync(`explorer "${dir}"`);
    else if (p === "darwin") execSync(`open "${dir}"`);
    else execSync(`xdg-open "${dir}"`);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ── Resolve local .minecraft/saves path for current OS user ──────────────────
app.get("/api/local-mc-path", (req, res) => {
  const p = os.platform();
  let savesPath;
  if (p === "win32") {
    savesPath = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), ".minecraft", "saves");
  } else if (p === "darwin") {
    savesPath = path.join(os.homedir(), "Library", "Application Support", "minecraft", "saves");
  } else {
    savesPath = path.join(os.homedir(), ".minecraft", "saves");
  }
  const exists = fs.existsSync(savesPath);
  res.json({ path: savesPath, exists });
});

// ── Compute conflict count between incoming ops and an existing region dir ────
// Given a destination region dir and a list of dest filenames that would be
// written, returns which of those files already exist and their sizes/mtimes.
app.post("/api/dest-conflicts", (req, res) => {
  const { destRegionDir, destFiles } = req.body;
  if (!destRegionDir || !destFiles) return res.status(400).json({ error: "Missing params." });
  const conflicts = [];
  for (const fname of destFiles) {
    const fp = path.join(destRegionDir, fname);
    try {
      if (fs.existsSync(fp)) {
        const st = fs.statSync(fp);
        conflicts.push({ file: fname, sizeBytes: st.size, mtime: st.mtimeMs });
      }
    } catch {}
  }
  res.json({ conflicts, total: destFiles.length, conflictCount: conflicts.length });
});


// ── List all world folders under the saves root ────────────────────────────────
// Hardcoded to Fred's saves path; can be overridden via ?root= query param.
// Returns every subfolder, noting whether it has a region dir, how many .mca
// files it contains, how many are >= 100 KB, total size, and newest mtime.
// Default saves root: same as the local .minecraft/saves used by the destination picker
const SAVES_ROOT = (() => {
  const p = os.platform();
  if (p === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), ".minecraft", "saves");
  if (p === "darwin") return path.join(os.homedir(), "Library", "Application Support", "minecraft", "saves");
  return path.join(os.homedir(), ".minecraft", "saves");
})();
const MIN_SIZE_BYTES = 100 * 1024;

// Dimension identifiers and their human labels
const DIMS = [
  { id: "overworld", label: "Overworld" },
  { id: "the_nether", label: "Nether" },
  { id: "the_end",    label: "The End" },
];

// ── Detect available region dirs for a world, supporting both formats ──────────
// Old (pre-1.18):  world/region/
// New (1.18+):     world/dimensions/minecraft/<dim>/region/
// Subfolder types we handle — each uses the same .mca coordinate system
const MCA_SUBFOLDERS = [
  { key: "region",   label: "Chunks"   },
  { key: "entities", label: "Entities" },
  { key: "poi",      label: "POI"      },
];

function detectDimensions(worldDir) {
  const dims = [];
  // New format (1.18+): world/dimensions/minecraft/<dim>/<subfolder>/
  const newBase = path.join(worldDir, "dimensions", "minecraft");
  if (fs.existsSync(newBase)) {
    for (const { id, label } of DIMS) {
      const dimBase = path.join(newBase, id);
      // Collect which subfolders exist for this dimension
      const subfolders = {};
      for (const { key } of MCA_SUBFOLDERS) {
        const dir = path.join(dimBase, key);
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) subfolders[key] = dir;
      }
      if (Object.keys(subfolders).length > 0) {
        dims.push({ id, label, regionDir: subfolders.region || null, subfolders, format: "new" });
      }
    }
  }
  // Old format: world/region/ (and world/entities/, world/poi/ if present)
  const alreadyHasOW = dims.some(d => d.id === "overworld");
  if (!alreadyHasOW) {
    const subfolders = {};
    for (const { key } of MCA_SUBFOLDERS) {
      const dir = path.join(worldDir, key);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) subfolders[key] = dir;
    }
    if (Object.keys(subfolders).length > 0) {
      dims.push({ id: "overworld", label: "Overworld", regionDir: subfolders.region || null, subfolders, format: "old" });
    }
  }
  return dims;
}

// ── Scan .mca stats from a single region directory ────────────────────────────
function scanRegionDir(regionDir, minSizeBytes) {
  const files = fs.readdirSync(regionDir).filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f));
  let totalFiles = 0, qualifyingFiles = 0, totalBytes = 0, newestMtime = 0;
  const fileSizes = [];
  files.forEach(f => {
    try {
      const st = fs.statSync(path.join(regionDir, f));
      totalFiles++;
      totalBytes += st.size;
      fileSizes.push(st.size);
      if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
      if (st.size >= minSizeBytes) qualifyingFiles++;
    } catch {}
  });
  return { totalFiles, qualifyingFiles, totalBytes, newestMtime, fileSizes };
}

app.get("/api/list-saves", (req, res) => {
  const root = req.query.root || SAVES_ROOT;
  try {
    if (!fs.existsSync(root)) return res.status(400).json({ error: "Saves root not found: " + root });
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const worldDir = path.join(root, e.name);
        const dimensions = detectDimensions(worldDir);

        // Aggregate stats across all dimensions for the row-level display
        let totalFiles = 0, qualifyingFiles = 0, totalBytes = 0, newestMtime = 0, fileSizes = [];
        const dimStats = dimensions.map(d => {
          try {
            // Scan region subfolder for the main file count/size display
            const regionStats = d.regionDir ? scanRegionDir(d.regionDir, MIN_SIZE_BYTES)
              : { totalFiles: 0, qualifyingFiles: 0, totalBytes: 0, newestMtime: 0, fileSizes: [] };
            // Also count entities and poi for display
            const entityCount = d.subfolders && d.subfolders.entities
              ? fs.readdirSync(d.subfolders.entities).filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f) && fs.statSync(path.join(d.subfolders.entities, f)).size > 0).length
              : 0;
            const poiCount = d.subfolders && d.subfolders.poi
              ? fs.readdirSync(d.subfolders.poi).filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f) && fs.statSync(path.join(d.subfolders.poi, f)).size > 0).length
              : 0;
            totalFiles     += regionStats.totalFiles;
            qualifyingFiles+= regionStats.qualifyingFiles;
            totalBytes     += regionStats.totalBytes;
            if (regionStats.newestMtime > newestMtime) newestMtime = regionStats.newestMtime;
            fileSizes = fileSizes.concat(regionStats.fileSizes);
            return { ...d, ...regionStats, entityCount, poiCount };
          } catch { return { ...d, totalFiles: 0, qualifyingFiles: 0, totalBytes: 0, fileSizes: [], entityCount: 0, poiCount: 0 }; }
        });

        const hasRegion = dimensions.length > 0;
        let worldMtime = newestMtime;
        try { worldMtime = Math.max(worldMtime, fs.statSync(worldDir).mtimeMs); } catch {}

        // For backwards compat: regionDir points to overworld (or first dim)
        const primaryDim = dimStats.find(d => d.id === "overworld") || dimStats[0] || null;

        const dataVersion = readWorldDataVersion(worldDir);
        return {
          name: e.name, worldDir,
          regionDir: primaryDim ? primaryDim.regionDir : null,
          hasRegion, totalFiles, qualifyingFiles, totalBytes,
          mtime: worldMtime, fileSizes,
          dimensions: dimStats,
          format: primaryDim ? primaryDim.format : null,
          dataVersion,
          versionLabel: labelForDataVersion(dataVersion),
          // Coordinate patch always applied silently during execute
        };
      });
    entries.sort((a, b) => {
      if (a.qualifyingFiles > 0 && b.qualifyingFiles === 0) return -1;
      if (b.qualifyingFiles > 0 && a.qualifyingFiles === 0) return 1;
      return b.mtime - a.mtime;
    });
    res.json({ root, worlds: entries, minSizeKb: MIN_SIZE_BYTES / 1024 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scan and return qualifying .mca files from selected region dirs ───────────
app.post("/api/import-saves", (req, res) => {
  // regionDirs entries: { regionDir, worldName, subfolders? }
  // subfolders = { region, entities, poi } — each a directory path or undefined
  const { regionDirs, minSizeBytes = MIN_SIZE_BYTES } = req.body;
  if (!regionDirs || !regionDirs.length) return res.status(400).json({ error: "No region directories provided." });

  function scanDir(dir, minBytes) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { regions: [], skippedSmall: 0 };
    const allFiles = fs.readdirSync(dir).filter(f => /^r\.([-\d]+)\.([-\d]+)\.mca$/.test(f));
    const regions = [];
    for (const f of allFiles) {
      try {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        if (st.size < minBytes) continue;
        const m = f.match(/^r\.([-\d]+)\.([-\d]+)\.mca$/);
        regions.push({ file: f, x: parseInt(m[1]), z: parseInt(m[2]), sizeBytes: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    return { regions, skippedSmall: allFiles.length - regions.length };
  }

  const results = [];
  for (const { regionDir, worldName, subfolders } of regionDirs) {
    try {
      const subs = subfolders || { region: regionDir };
      // Always use 0 minSize for entities/poi — they're often small but still meaningful
      const regionResult   = scanDir(subs.region,   minSizeBytes);
      const entitiesResult = scanDir(subs.entities, 0);
      const poiResult      = scanDir(subs.poi,      0);
      results.push({
        worldName, regionDir,
        regions:   regionResult.regions,
        entities:  entitiesResult.regions,
        poi:       poiResult.regions,
        subfolders: subs,
        skippedSmall: regionResult.skippedSmall,
      });
    } catch (e) { results.push({ worldName, regionDir, error: e.message, regions: [], entities: [], poi: [] }); }
  }
  res.json({ results });
});


app.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ╔═════════════════════════════════════════╗`);
  console.log(`  ║  MC Region Tool  →  ${url}  ║`);
  console.log(`  ╚═════════════════════════════════════════╝\n`);
  const p = os.platform();
  try {
    if (p === "win32") execSync(`start ${url}`);
    else if (p === "darwin") execSync(`open ${url}`);
    else execSync(`xdg-open ${url}`);
  } catch {}
});
