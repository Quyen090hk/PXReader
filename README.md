# PXReader

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="PXReader application icon" />
</p>

PXReader is a local-first desktop reader for EPUB, TXT, and PDF. It keeps books, reading progress, search indexes, and annotations on the device so that a focused reading workflow does not require an account or network service.

## Highlights

- Read local EPUB, TXT, and PDF files from one workspace.
- Keep an on-device library with independent reading progress for each book.
- Navigate by table of contents, previous/next controls, keyboard, touch, or reading gestures.
- Search full text in a background worker without blocking the reading view.
- Select text to create highlights and notes, then return to the recorded location.
- Use immersion mode to focus on the page while keeping essential controls available.
- Choose P3, P4, or P5 visual styles and switch light/dark mode from the reader.

## Reading Experience

PXReader is designed around continuous reading rather than document management overhead.

- **Responsive workspace**: library, reader, and tool rails can be opened or collapsed independently. When the table of contents is hidden, the reader header shows the current chapter title.
- **Table of contents recovery**: click the `目录` header to bring the active chapter back to the top of the outline after manually browsing a long list.
- **Progress continuity**: progress is saved per book and shown to two decimal places.
- **Scroll chapter gestures**: in immersion mode, continue scrolling past the bottom to move forward; push upward from the top to return to the previous chapter at its end. This also works for short chapters that do not produce a scrollbar.
- **EPUB layout switch**: EPUB can switch between continuous and paged reading. The switch reuses the current chapter DOM and recalculates page metrics instead of reparsing the chapter.
- **Comfort controls**: font scale, page controls, rail state, theme, and layout preference are retained locally.

## Format Support

| Format | Capabilities |
| --- | --- |
| EPUB | Package and outline parsing, local resource rewriting, internal links, continuous or paged reading, full-text search, and annotations. |
| TXT | UTF-8, GB18030, and Big5 decoding attempts, automatic chapter splitting, continuous reading, search, and annotations. |
| PDF | Canvas rendering, selectable text layer, single/double-page reading based on available space, outline navigation, search, and annotations. |

## Privacy and Local Data

PXReader does not upload book content to a remote service. Imported books are stored locally through IndexedDB or the desktop WebView, while progress, annotations, theme, rail state, zoom, and layout preferences are stored locally on the device.

Clear local browser/WebView data only after backing up any books or notes that must be retained.

## Quick Start

### Requirements

- Node.js 20 or newer
- npm 10 or newer

### Web Preview

```powershell
npm install
npm run serve
```

Open [http://localhost:5173](http://localhost:5173) in a browser. Use the local server instead of opening `index.html` with `file://`, because full-text search depends on a Web Worker.

### Desktop Development

PXReader uses Tauri v2 for desktop packaging. Install a current Rust toolchain and the platform prerequisites required by Tauri, then run:

```powershell
npm install
npm run tauri:dev
```

Create the Windows NSIS installer with:

```powershell
npm run tauri:build
```

The desktop bundle uses `src-tauri/icons/icon.ico`. The PNG source is retained at `src-tauri/icons/icon.png` and is also used as the browser favicon.

## Quality Checks

```powershell
npm run check
```

This validates the browser modules and rebuilds the distributable static assets in `dist/`.

## Project Structure

```text
.
|- src/
|  |- app.js              # Reader state, format adapters, and interactions
|  |- search-worker.js    # Background full-text indexing and search
|  `- styles.css          # Themes, responsive layout, and reader UI
|- src-tauri/
|  |- icons/              # Desktop icon source and Windows icon bundle
|  |- src/                # Tauri application entry points
|  `- tauri.conf.json     # Desktop window and bundle configuration
|- scripts/
|  |- build-static.mjs    # Static web build
|  `- serve-static.cjs    # Local preview server
|- index.html             # Application shell
`- README.md
```

## Architecture

`src/app.js` exposes a shared reading workflow through three format adapters:

- `TxtAdapter`
- `EpubAdapter`
- `PdfAdapter`

Each adapter owns loading, navigation, search units, progress calculations, and rendering for its format. The UI layer coordinates the active book, view state, annotations, and local persistence, keeping format-specific behavior isolated from the surrounding reader interface.
