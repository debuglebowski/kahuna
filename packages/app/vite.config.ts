import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // libavoid-js's `exports` map hides its .wasm; alias it so `?url` can
      // emit it as an asset (see src/lib/graphRouting.ts). Regex so the
      // `?url` suffix survives the rewrite.
      {
        find: /^libavoid-wasm(\?.*)?$/,
        replacement: `${fileURLToPath(new URL("./node_modules/libavoid-js/dist/libavoid.wasm", import.meta.url))}$1`,
      },
    ],
  },
  // react-grid-layout's `react-draggable` reads `process.env.*` at runtime inside
  // the drag/resize lifecycle; the browser has no `process`, so without these the
  // handlers throw "process is not defined" and drag/resize silently abort.
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  server: {
    // 5173 is permanently held by SlayZone's electron-vite, so Vite's default
    // silently drifts to 5174+. Pin to 5100 (pairs with the API on 3100);
    // strictPort makes a taken port a hard error instead of a silent bump —
    // a drifted origin breaks anything that assumes the dev URL.
    port: 5100,
    strictPort: true,
    proxy: {
      // Forward API + auth traffic to the Bun server during development.
      // API_PROXY lets a second dev stack point at its own server instance.
      "/api": process.env.API_PROXY ?? "http://localhost:3100",
    },
  },
}))
