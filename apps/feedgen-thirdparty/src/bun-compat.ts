/**
 * Preloaded by bunfig.toml. `@atproto/sync` → `@atproto/identity` →
 * `@atproto-labs/fetch-node` loads undici 8, which calls
 * `worker_threads.markAsUncloneable` at import time; Bun 1.3 lacks it. It
 * only restricts structured cloning, so a no-op is safe. (Our own copy: a
 * third party shares no code with the AppView.)
 */
import workerThreads from "node:worker_threads"

const wt = workerThreads as { markAsUncloneable?: (value: object) => void }
wt.markAsUncloneable ??= () => {}
