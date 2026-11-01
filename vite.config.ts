import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * Excalidraw resolves its fonts relative to `window.EXCALIDRAW_ASSET_PATH`
 * (`fonts/<Family>/…`, see DrawingCanvas); without it they fall back to their
 * CDN, which is unusable offline. So dev serves the files straight out of
 * node_modules through middleware, and build copies them into dist.
 */
function excalidrawAssets(): Plugin {
  const pkgProd = path.resolve(
    __dirname,
    "node_modules/@excalidraw/excalidraw/dist/prod",
  );
  const MIME: Record<string, string> = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  return {
    name: "excalidraw-assets",
    configureServer(server) {
      server.middlewares.use("/excalidraw-assets", (req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const rel = decodeURIComponent(url).replace(/^\/+/, "");
        if (!rel || rel.includes("..")) return next();
        const full = path.join(pkgProd, rel);
        if (!full.startsWith(pkgProd + path.sep)) return next();
        fs.readFile(full, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader(
            "Content-Type",
            MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
          );
          res.end(data);
        });
      });
    },
    closeBundle() {
      for (const dir of ["fonts", "data"]) {
        const src = path.join(pkgProd, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.resolve(__dirname, "dist/excalidraw-assets", dir), {
            recursive: true,
          });
        }
      }
    },
  };
}

/**
 * pdf.js fetches its CMaps (CJK font mappings) and standard fonts at runtime
 * by URL, so they never go through the bundler. Same trick as the Excalidraw
 * assets above: dev serves them from node_modules through middleware, build
 * copies them into dist. Without the cmaps, a Chinese PDF without embedded
 * fonts loses every glyph on the page.
 */
function pdfjsAssets(): Plugin {
  const pkgProd = path.resolve(__dirname, "node_modules/pdfjs-dist");
  const DIRS = ["cmaps", "standard_fonts"];
  const MIME: Record<string, string> = {
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  };
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs-assets", (req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const rel = decodeURIComponent(url).replace(/^\/+/, "");
        if (!rel || rel.includes("..")) return next();
        const [dir, ...rest] = rel.split("/");
        if (!DIRS.includes(dir) || rest.length === 0) return next();
        const base = path.join(pkgProd, dir);
        const full = path.join(base, ...rest);
        if (!full.startsWith(base + path.sep)) return next();
        fs.readFile(full, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader(
            "Content-Type",
            MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
          );
          res.end(data);
        });
      });
    },
    closeBundle() {
      for (const dir of DIRS) {
        const src = path.join(pkgProd, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.resolve(__dirname, "dist/pdfjs-assets", dir), {
            recursive: true,
          });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), excalidrawAssets(), pdfjsAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
