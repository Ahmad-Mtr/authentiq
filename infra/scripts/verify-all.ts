/**
 * Runs every verify and eval script against the live stack, in dependency
 * order, then prints one summary table: result, checks passed, duration and
 * model cost per script. Exits non-zero if any script failed.
 *
 * Cost is measured, not estimated. Most model calls happen inside the
 * AppView (resume parsing, embeddings, the agent), so before and after each
 * script this reads the AppView's token counters (`GET /_admin/usage`, which
 * needs ADMIN_TOKEN) and prices the difference. Scripts that call Mistral
 * themselves (eval:resume) print their own cost line, which is added.
 *
 * Every script runs even after a failure, so one run shows everything.
 * Output streams as it happens and is also kept, one log per script, in a
 * temp directory printed at the end.
 *
 *   bun run verify:all
 *   bun run verify:all -- --only verify:jobs,eval:search
 *   bun run verify:all -- --bail            # stop at the first failure
 *
 * Needs the stack (`bun run dev`), the seeds (see the README) and
 * MISTRAL_API_KEY in apps/appview/.env.
 */
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_NETWORK } from "@workspace/atproto"

const root = join(import.meta.dir, "..", "..")
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const appviewEnv = Object.fromEntries(
  (await Bun.file(join(root, "apps/appview/.env")).text())
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)

type Step = {
  script: string
  /** Why it sits where it does, or what it needs. */
  needs: string
  /** The script calls Mistral in its own process and prints "≈ $x". */
  ownCost?: boolean
  /** A line of the output worth repeating in the table. */
  headline?: RegExp
}

/**
 * Dependency order: the network and sign-in first, then the indexer every
 * later feature reads from, then resume parsing, search (which the agent's
 * tools call), the agent, and the social layer, jobs and feeds built on top.
 */
const STEPS: Array<Step> = [
  { script: "verify:lexicons", needs: "PDS" },
  { script: "verify:oauth", needs: "PDS, web" },
  { script: "verify:indexer", needs: "AppView, ADMIN_TOKEN" },
  { script: "verify:resume", needs: "web, AppView, Mistral" },
  {
    script: "eval:resume",
    needs: "Mistral (in process)",
    ownCost: true,
    headline: /^overall \(micro\)\s+(.*?)\s+\(tp/m,
  },
  { script: "verify:search", needs: "seed:talent, ADMIN_TOKEN" },
  {
    script: "eval:search",
    needs: "seed:talent",
    headline: /^(nDCG@10 \(all\)\s+.*)$/m,
  },
  { script: "verify:agent", needs: "seed:talent, web, Mistral" },
  {
    script: "eval:agent",
    needs: "seed:talent, seed:jobs, Mistral (in process)",
    ownCost: true,
    headline: /^(passed \d+ of \d+.*)$/m,
  },
  { script: "verify:social", needs: "seed:social, web, ADMIN_TOKEN" },
  { script: "verify:jobs", needs: "seed:jobs, seed:talent, web, Mistral" },
  { script: "verify:feeds", needs: "seed:feeds, web" },
  {
    script: "eval:bias",
    needs: "seed:talent, seed:jobs, Mistral",
    headline: /^(summary: .*)$/m,
  },
]

const args = process.argv.slice(2)
const only = args.includes("--only")
  ? args[args.indexOf("--only") + 1]!.split(",")
  : undefined
const bail = args.includes("--bail")
const steps = only ? STEPS.filter((s) => only.includes(s.script)) : STEPS
if (only && steps.length !== only.length) {
  const known = new Set(STEPS.map((s) => s.script))
  console.log(`✗ unknown script(s): ${only.filter((o) => !known.has(o)).join(", ")}`)
  process.exit(1)
}

async function appviewSpend(): Promise<number | undefined> {
  if (!appviewEnv.ADMIN_TOKEN) return undefined
  try {
    const res = await fetch(`${APPVIEW}/_admin/usage`, {
      headers: { authorization: `Bearer ${appviewEnv.ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return undefined
    return ((await res.json()) as { costUsd: number }).costUsd
  } catch {
    return undefined
  }
}

/** Runs `bun run <script>`, streaming its output and keeping a copy. */
async function run(script: string, log: string) {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  let output = ""
  const pump = async (stream: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      output += text
      to.write(text)
    }
  }
  await Promise.all([
    pump(proc.stdout, process.stdout),
    pump(proc.stderr, process.stderr),
  ])
  const code = await proc.exited
  await Bun.write(log, output)
  return { code, output }
}

// --- preflight --------------------------------------------------------------------

const health = await fetch(`${APPVIEW}/xrpc/_health`, {
  signal: AbortSignal.timeout(3000),
})
  .then((r) => r.json() as Promise<Record<string, any>>)
  .catch(() => undefined)
if (!health?.indexer?.running) {
  console.log(`✗ the AppView is not running at ${APPVIEW}: start it with bun run dev`)
  process.exit(1)
}
if (!appviewEnv.MISTRAL_API_KEY) {
  console.log("✗ MISTRAL_API_KEY is not set in apps/appview/.env")
  process.exit(1)
}
const measured = (await appviewSpend()) !== undefined
if (!measured) {
  console.log(
    "· ADMIN_TOKEN missing or /_admin/usage unreachable: AppView-side model cost will show as ?"
  )
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const logDir = join(tmpdir(), "authentiq-verify-all", stamp)
mkdirSync(logDir, { recursive: true })

type Result = {
  step: Step
  ok: boolean
  passed: number
  failed: number
  ms: number
  cost: number | undefined
  headline?: string
}
const results: Array<Result> = []
const started = performance.now()

for (const step of steps) {
  console.log(`\n━━━ ${step.script} (${step.needs}) ━━━`)
  const before = await appviewSpend()
  const t0 = performance.now()
  const { code, output } = await run(
    step.script,
    join(logDir, `${step.script.replace(":", "-")}.log`)
  )
  const ms = performance.now() - t0
  const after = await appviewSpend()
  const own = step.ownCost
    ? Number(output.match(/≈ \$([0-9.]+)/)?.[1] ?? Number.NaN)
    : 0
  // A drop means the AppView restarted mid-script (its counters are per
  // process), so the difference measures nothing.
  const appview =
    before !== undefined && after !== undefined && after >= before
      ? after - before
      : undefined
  const passed = output.match(/^✓ /gm)?.length ?? 0
  const failed = output.match(/^✗ /gm)?.length ?? 0
  results.push({
    step,
    ok: code === 0 && failed === 0,
    passed,
    failed,
    ms,
    cost: appview === undefined ? undefined : appview + own,
    headline: step.headline
      ? output.match(step.headline)?.[1]?.replace(/\s+/g, " ").trim()
      : undefined,
  })
  if (bail && code !== 0) break
}

// --- summary ----------------------------------------------------------------------

const seconds = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
    : `${(ms / 1000).toFixed(1)}s`
const dollars = (n: number | undefined) =>
  n === undefined || Number.isNaN(n)
    ? "?"
    : n === 0
      ? "—"
      : n < 0.0001
        ? "<$0.0001"
        : `$${n.toFixed(4)}`

console.log(`\n${"━".repeat(78)}`)
console.log(
  `${"script".padEnd(16)} ${"result".padEnd(6)} ${"checks".padStart(9)} ${"time".padStart(8)} ${"cost".padStart(9)}   notes`
)
for (const r of results) {
  console.log(
    `${r.step.script.padEnd(16)} ${(r.ok ? "✓" : "✗").padEnd(6)} ${`${r.passed}/${r.passed + r.failed}`.padStart(9)} ${seconds(r.ms).padStart(8)} ${dollars(r.cost).padStart(9)}   ${r.headline ?? ""}`
  )
}
const total = results.reduce<number | undefined>(
  (sum, r) => (sum === undefined || r.cost === undefined ? undefined : sum + r.cost),
  0
)
const failedSteps = results.filter((r) => !r.ok)
console.log(
  `${"total".padEnd(16)} ${(failedSteps.length ? "✗" : "✓").padEnd(6)} ${`${results.reduce((a, r) => a + r.passed, 0)}/${results.reduce((a, r) => a + r.passed + r.failed, 0)}`.padStart(9)} ${seconds(performance.now() - started).padStart(8)} ${dollars(total).padStart(9)}`
)
console.log(
  `\ncost: list prices (packages/ai PRICES) × tokens counted by the AppView${measured ? "" : " (unavailable)"}, plus each in-process eval's own count`
)
console.log(`logs: ${logDir}`)
if (failedSteps.length) {
  console.log(`\n✗ ${failedSteps.length} script(s) failed: ${failedSteps.map((r) => r.step.script).join(", ")}`)
  process.exit(1)
}
console.log(`\nall ${results.length} scripts passed`)
