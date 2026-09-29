/**
 * Preloaded by bunfig.toml. A plain first import is not enough: Bun loads the
 * CommonJS dependencies below before any ES module body runs.
 *
 * `@atproto/sync` → `@atproto/identity` → `@atproto-labs/fetch-node` imports
 * undici 6, 7 and 8 up front and picks one by Node version at call time. Under
 * Bun (which reports Node 24) undici 7 is the one used, but undici 8 still
 * loads, and at load it calls `markAsUncloneable` from `node:worker_threads`,
 * which Bun 1.3 does not implement. It only restricts structured cloning, so a
 * no-op is safe.
 */
import workerThreads from "node:worker_threads"

const wt = workerThreads as { markAsUncloneable?: (value: object) => void }
wt.markAsUncloneable ??= () => {}
