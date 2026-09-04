import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
}

mkdirSync(dist, { recursive: true });
cpSync(resolve(root, "index.html"), resolve(dist, "index.html"));
copyFileSync(resolve(root, "src-tauri/icons/icon.png"), resolve(dist, "icon.png"));
mkdirSync(resolve(dist, "src"), { recursive: true });
copyFileSync(resolve(root, "src/styles.css"), resolve(dist, "src/styles.css"));
copyFileSync(resolve(root, "src/search-worker.js"), resolve(dist, "src/search-worker.js"));

await build({
  entryPoints: [resolve(root, "src/app.js")],
  outfile: resolve(dist, "src/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome105"],
  minify: true,
  legalComments: "none",
});

const vendor = resolve(dist, "vendor");
mkdirSync(vendor, { recursive: true });
copyFileSync(resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), resolve(vendor, "pdf.worker.min.mjs"));
