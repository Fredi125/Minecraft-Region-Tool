# MC Region Placement Tool

A local desktop-style web tool for planning and executing Minecraft `.mca` region file imports across multiple source worlds.

## Requirements
- Node.js 16+ (https://nodejs.org)

## Usage (Windows)
Double-click `start.bat` — it will install dependencies and open your browser automatically.

## Usage (Linux / macOS)
```bash
chmod +x start.sh
./start.sh
```

## Features
- **Browse** to select source world region folders (native OS folder picker)
- **Visual grid** — drag worlds around to position them; auto-arrange side by side
- **Manual offset inputs** in the sidebar for precise placement
- **Overlap detection** — highlights any conflicting regions in orange
- **Output panel** — generates Copy-Item / cp / copy commands in your preferred shell
- **⚡ Execute** — copies files directly from source to destination with a results summary
- **Open folder** shortcut after execution

## How it works
Each `.mca` file covers a 512×512 block area. The filename `r.X.Z.mca` maps to:
- Block X range: `X * 512` to `X * 512 + 511`
- Block Z range: `Z * 512` to `Z * 512 + 511`

Setting an offset of +5 on X shifts all files in that world 5 regions (2560 blocks) east.

## Ports
The tool runs on `localhost:25599`. Change the `PORT` constant in `server.js` if needed.
