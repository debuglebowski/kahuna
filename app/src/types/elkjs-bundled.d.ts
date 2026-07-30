// elkjs only declares types for its root entry; the worker-free bundled build
// shares the exact same API surface.
declare module "elkjs/lib/elk.bundled.js" {
  export * from "elkjs"
  export { default } from "elkjs"
}
