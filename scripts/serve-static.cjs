const { createReadStream, existsSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize, resolve } = require("node:path");

const root = resolve(__dirname, "..", "dist");
const port = Number(process.env.PORT || 5173);

const mimes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

process.on("uncaughtException", (error) => {
  writeFileSync(join(root, "server.err.log"), `${error.stack || error}\n`);
  process.exit(1);
});

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": mimes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(response);
});

server.on("error", (error) => {
  writeFileSync(join(root, "server.err.log"), `${error.stack || error}\n`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  if (process.stdout.isTTY) {
    console.log(`PXReader dev server: http://127.0.0.1:${port}`);
  }
});
