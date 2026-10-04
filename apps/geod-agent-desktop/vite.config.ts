import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createReadStream, cpSync, existsSync, statSync } from "node:fs";
import { resolve, sep, extname } from "node:path";

function cesiumAssets(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/cesium/Build/Cesium", import.meta.url));
  let output = "";
  return {
    name: "geod-cesium-assets",
    configResolved(config) { output = resolve(config.root, config.build.outDir, "cesium"); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const raw = request.url?.split("?")[0] ?? "";
        if (!raw.startsWith("/cesium/")) return next();
        let path: string;
        try { path = resolve(root, decodeURIComponent(raw.slice(8))); } catch { response.statusCode = 400; response.end(); return; }
        if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) { response.statusCode = 404; response.end(); return; }
        const types: Record<string, string> = { ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
        response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
        createReadStream(path).pipe(response);
      });
    },
    closeBundle() {
      for (const folder of ["Assets", "ThirdParty", "Workers", "Widgets"]) cpSync(resolve(root, folder), resolve(output, folder), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cesiumAssets()],
  define: { CESIUM_BASE_URL: JSON.stringify("/cesium/") },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
