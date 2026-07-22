# Layers — PDF Drafting & Markup Tool

A professional desktop application for annotating, drafting, and marking up PDF documents. Built with Tauri, React, and TypeScript.

## ✨ Features

- **Multi-page PDF support** — open, view, and navigate any PDF
- **Spread layout** — side-by-side page view for booklets and publications
- **Drawing tools** — lines, shapes, polylines, freehand, text, and tables
- **Hatch patterns** — architectural fill patterns (concrete, brick, steel, insulation, and more)
- **Master pages** — apply reusable underlays across multiple pages
- **Snap & guides** — pixel-perfect alignment with snap grid and draggable guides
- **PDF export** — flatten all markup directly into the PDF with full vector fidelity
- **Screen snipping** — capture any monitor region and place it on the canvas
- **Multi-tab** — work on multiple documents simultaneously
- **Dark UI** — sleek dark-mode interface designed for long working sessions

## 📥 Download & Install

**Just want to use the app?** Download the installer for your platform:

| Platform | Installer | Type |
|----------|-----------|------|
| Windows 64-bit | [Vajra_0.1.0_x64-setup.exe](../../releases/latest) | NSIS setup wizard |
| Windows 64-bit | [Vajra_0.1.0_x64_en-US.msi](../../releases/latest) | MSI package |

> Download from the [Releases](../../releases/latest) page. No compilation required — just install and run.

## 🛠️ Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Tauri CLI prerequisites for Windows](https://tauri.app/start/prerequisites/)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO/pdf-markup-app

# 2. Install JavaScript dependencies
npm install

# 3. Run in development mode (opens the desktop window)
npx tauri dev

# 4. Build a production installer
npx tauri build
# Installers will be at: src-tauri/target/release/bundle/
```

> **First build takes ~5–15 minutes** as Rust compiles all dependencies. Subsequent builds are much faster.

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust backend) |
| Frontend | [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org/) |
| Canvas rendering | [Konva.js](https://konvajs.org/) / [react-konva](https://github.com/konvajs/react-konva) |
| PDF rendering | [PDF.js](https://mozilla.github.io/pdf.js/) |
| PDF generation | [pdf-lib](https://pdf-lib.js.org/) |
| State management | [Zustand](https://zustand-demo.pmnd.rs/) |
| Build tool | [Vite](https://vite.dev/) |
| Screen capture | [xcap](https://github.com/nashaofu/xcap) (Rust) |

## 📁 Project Structure

```
pdf-markup-app/
├── src/
│   ├── components/        # UI components (DocumentViewer, panels, dialogs)
│   ├── store/             # Zustand global state & TypeScript types
│   └── utils/             # PDF export, canvas renderer, pattern engine
├── src-tauri/
│   ├── src/               # Rust backend (screen capture, global shortcuts)
│   ├── icons/             # App icons (all platforms)
│   ├── capabilities/      # Tauri security permissions
│   └── tauri.conf.json    # Tauri configuration
├── public/                # Static assets (favicon, icons)
└── index.html             # HTML entry point
```

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.
