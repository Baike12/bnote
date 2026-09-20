import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * Excalidraw 的字体按 `window.EXCALIDRAW_ASSET_PATH` 相对寻址
 * (`fonts/<Family>/…`,见 DrawingCanvas),缺省会落到它的 CDN——离线不可用,
 * 所以 dev 由中间件直接服务 node_modules 里的文件,build 时拷进 dist。
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

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), excalidrawAssets()],
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
