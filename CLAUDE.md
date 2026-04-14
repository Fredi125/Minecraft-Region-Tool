# CLAUDE.md — MC Region Tool

## Project overview

A local Node.js/Express desktop tool (browser UI at `localhost:25599`) for merging Minecraft `.mca` region files from multiple source worlds into a destination world. The core technique is offset-based renaming: place worlds on a visual grid, compute the coordinate delta, rename files accordingly, and patch chunk coordinates inside the NBT binary data so Minecraft accepts them.

**Target use case:** a small private server (5–10 players) merging several pre-existing worlds (2019–2026) into one new world running Minecraft 1.21+ with mods.

---

## Stack

- **Runtime:** Node.js + Express (`server.js`) — no build step, no npm frontend framework
- **UI:** Single-page HTML/JS/CSS (`public/index.html`) — vanilla JS, canvas-based grid
- **Start:** `start.bat` (Windows) or `start.sh` (Linux/macOS) → `node server.js`
- **Port:** 25599

---

## File structure

```
mc-region-tool/
├── server.js              # Express server + all file I/O + NBT patching
├── public/
│   └── index.html         # Entire UI: HTML + inline <style> + inline <script>
├── package.json
├── start.bat
├── start.sh
└── CLAUDE.md
```

There are **no separate CSS or JS files** — everything is inline in `index.html`. This was an intentional choice for portability (single file, no build step).

---

## Architecture: data flow

```
Import from Saves modal
  └─ /api/list-saves        → scans worlds, returns dims + subfolders
  └─ /api/import-saves      → scans region/entities/poi dirs, returns file lists

Grid editor (canvas)
  └─ worlds[] state         → each world has: regions[], entities[], poi[], subfolders{}, ox, oz, bounds

Execute button
  └─ execAll()
      └─ /api/preflight     → detects world-vs-world and dest conflicts, keyed by "subfolder:destFile"
      └─ conflict modal     → user resolves or bulk-resolves
      └─ doExecute()
          └─ /api/execute   → copies files, patches NBT, routes to correct subfolder
```

---

## Critical data structures

### World object (client-side, `worlds[]` array)
```js
{
  id,           // incrementing int
  name,         // display name (may include dim suffix like " (Nether)")
  dir,          // absolute path to region/ folder
  color,        // { bg: "#hex", dim: "#hex" } — assigned from PALETTE
  regions,      // [{ file, x, z, sizeBytes, mtime }] — region coords (before offset)
  entities,     // [{ file, x, z, sizeBytes, mtime }] — matching entity files
  poi,          // [{ file, x, z, sizeBytes, mtime }]
  subfolders,   // { region: "/path/...", entities: "/path/...", poi: "/path/..." }
  ox, oz,       // region-coordinate offset applied to this world on the grid
  bounds,       // { minX, maxX, minZ, maxZ } — in SOURCE coords (before offset)
  versionLabel, // e.g. "1.21.4+" — display only, no logic
}
```

### Op object (sent to /api/execute)
```js
{
  from,           // source filename, e.g. "r.-1.2.mca"
  to,             // destination filename, e.g. "r.3.5.mca"
  srcDir,         // absolute path to source folder
  subfolder,      // "region" | "entities" | "poi"
  needsNbtPatch,  // true for region+entities, false for poi
  destDir,        // explicit destination folder (overrides server-side derivation)
  keepExisting,   // true = no-op, just log it
}
```

---

## NBT patching — the most critical logic

### Why it's needed
Minecraft 1.18+ validates that `xPos`/`zPos` in chunk NBT match the file's position. Renaming `r.0.0.mca` → `r.5.3.mca` without patching causes "Chunk found in invalid location" errors and the chunk is discarded.

### Region files → `patchMcaFile(srcPath, dstPath, regionX, regionZ)`
- Reads MCA file, decompresses each of up to 1024 chunk slots (gzip/zlib/raw)
- Calls `patchNbtInts(buf, { xPos, zPos })` which walks the NBT tree and patches `TAG_Int` fields named `xPos` and `zPos` wherever they appear (handles both pre-1.18 format with `Level` sub-compound and 1.18+ root-level format, because it recurses into all compounds)
- Recompresses, reconstructs MCA with updated location table
- **Always runs** regardless of source version — old chunks arriving in a 1.18+ world need it

### Entity files → `patchEntityMcaFile(srcPath, dstPath, srcRX, srcRZ, dstRX, dstRZ)`
- Block offset: `dx = (dstRX - srcRX) * 512`, `dz = (dstRZ - srcRZ) * 512`
- Calls `patchEntityNbt(buf, dx, dz)` which:
  - Updates the `Position` TAG_INT_ARRAY `[chunkX, chunkZ]` by `dx/16`, `dz/16`
  - Translates every entity's `Pos` TAG_LIST (3 doubles) by adding `dx`, `dz`
  - Recurses into `Passengers` compounds (riders in boats/minecarts etc.)
- On any parse error, returns original buffer unchanged (safe fallback)

### POI files
- Plain copy, no patching — different NBT structure, Minecraft re-derives POI on load if needed

---

## Coordinate system

- **Region coords**: what appears in filenames, e.g. `r.X.Z.mca` covers chunks `X*32` to `X*32+31` and blocks `X*512` to `X*512+511`
- **Chunk coords**: `xPos`, `zPos` inside NBT — `regionX * 32 + localX` where `localX` is 0–31
- **Block coords**: what players see in F3 — `chunkX * 16 + localBlock`
- **World offset (`ox`, `oz`)**: in REGION coords, stored on each world object. Applied as `destRegion = srcRegion + ox - originX`
- **Origin (`originX`, `originZ`)**: the amber crosshair on the grid. Subtracted from all destination names so the player can control where region 0,0 maps to in the destination

---

## Dimension folder formats

Modern (1.18+):
```
world/dimensions/minecraft/overworld/region/
world/dimensions/minecraft/overworld/entities/
world/dimensions/minecraft/overworld/poi/
world/dimensions/minecraft/the_nether/region/
world/dimensions/minecraft/the_end/region/
```

Old format (pre-1.18):
```
world/region/
world/entities/    (if upgraded to 1.17+ at some point)
world/poi/
```

`detectDimensions(worldDir)` checks both and returns a unified structure with `subfolders: { region, entities, poi }`.

---

## Preflight conflict detection

Conflicts are keyed by `"subfolder:destFile"` (e.g. `"entities:r.1.2.mca"`) — **not** just filename. This prevents entity/poi files from falsely conflicting with their matching region file. The server also checks each subfolder's own destination directory for existing files separately.

---

## Entities and POI: the "follow their region" model

`getOps()` in the client does **not** iterate `w.entities` independently. Instead, for every region file it emits, it checks whether a matching entity/poi file exists (by filename) and emits additional ops for those. This means:
- Entity/poi selection is implicit — they always follow their region
- If a region is removed via the Remove tool, its entity/poi files are also removed (`removeCell()` cleans all three arrays)
- If a region is deselected/not imported, neither are its entity/poi files

---

## Server-side destination routing

The execute endpoint derives the destination folder from `op.destDir` if set (which the client always provides), falling back to replacing the `region` segment in the destDir path with `op.subfolder`. Example:
```
destDir = "C:\...\Utopia\dimensions\minecraft\overworld\region"
subfolder = "entities"
effectiveDest = "C:\...\Utopia\dimensions\minecraft\overworld\entities"
```

---

## Grid UI

- **Canvas-based** — `renderGrid()` redraws the entire canvas on every change
- **Drag behaviour**: `dragState` holds a frozen bounding box (`frozenBounds`) captured at mousedown. During drag, `getAllPlaced()` substitutes preview offsets for the dragged world, but `w.ox`/`w.oz` are only written on mouseup. This prevents grid resize jitter during drag.
- **Cell size (`cellSize`)**: steps through `[2,3,4,6,8,12,16,20,24,32,40,50,64]` px. Labels/details only render above certain thresholds (pip ≥16, coords ≥28, entity bar always)
- **Entity density bar**: amber bar rising from cell bottom, height proportional to `sizeBytes` of matching entity file. Levels: <200KB (faint, 20%), 200–500KB (medium, 40%), >500KB (bright, 62%)
- **Remove tool**: toggle mode, hover shows red ✕, click or drag-paint removes cells. Escape exits.
- **Overlap warning bar**: always visible (fixed height), green when clean, amber when overlaps detected

---

## Known past bugs (DO NOT REPEAT)

### 1. Duplicate function definitions
The most persistent class of bug. `str.replace()` patching on a live file caused function bodies to appear twice. The first copy was always broken (unclosed braces from template literals confusing brace counters), causing it to swallow all subsequent function definitions. **Always verify brace balance with a string-aware counter before packaging.** The canonical check:

```python
def count_braces_no_strings(s):
    depth = 0; in_s = in_d = in_t = False; i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and (in_s or in_d or in_t): i += 2; continue
        if c == "'" and not in_d and not in_t: in_s = not in_s
        elif c == '"' and not in_s and not in_t: in_d = not in_d
        elif c == '`' and not in_s and not in_d: in_t = not in_t
        elif not in_s and not in_d and not in_t:
            if c == '{': depth += 1
            elif c == '}': depth -= 1
        i += 1
    return depth
```

### 2. Client-server contract mismatch
Two separate patches used different field names for the same concept (e.g. `entitiesDir`/`poiDir` vs `subfolders.entities`/`subfolders.poi`). Always verify that what the client sends matches what the server reads. The server expects `subfolders: { region, entities, poi }` — never flat `entitiesDir`/`poiDir`.

### 3. `renderConflictList` body replaced
The doExecute forEach conflict loop accidentally replaced the renderConflictList function body during a patch. The conflict modal showed empty cards. When editing doExecute, always verify renderConflictList is intact.

### 4. Origin offset not applied in preflight
`getOps()` correctly applies `w.ox - originX` but an early version of the preflight call sent raw `w.ox` without subtracting `originX`. Destination filenames were wrong. The preflight call must apply `ox: w.ox - originX, oz: w.oz - originZ`.

### 5. `needsNbtPatch` as UI flag
Early versions used `needsNbtPatch` both as a UI warning badge ("needs patch") and as a functional flag. This caused confusion when we removed the UI badge but the logic still depended on it. NBT patching is now **always on** for region and entity files — there is no per-world toggle, and no UI badge. The flag on individual ops (`needsNbtPatch: true/false`) is the only remaining use.

---

## Workflow for making changes

1. **Read the file** — always view the current state of the relevant function before patching
2. **String-replace carefully** — match exact whitespace and content; if the replace doesn't land, the old code silently remains
3. **Check brace balance** — run the string-aware counter over the `<script>` block, verify final depth = 0
4. **Check for duplicate functions** — count occurrences of `function <name>` for any function you edited
5. **`node --check server.js`** — catches syntax errors in the server
6. **Repackage** — `zip -r mc-region-tool.zip mc-region-tool/`

---

## Future features discussed but not yet implemented

- `--forceUpgrade` workflow integration in the UI (currently a manual step)
- Undo for the Remove tool
- Per-world dimension selector visible on the grid (currently only in the import modal)
