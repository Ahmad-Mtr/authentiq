/**
 * Creates infra/.env with fresh secrets, then materialises every
 * `.env.example` in apps/* and packages/* into a `.env` (never overwrites).
 *
 *   bun run infra:env
 */
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

const root = join(import.meta.dir, "..", "..")
const hex = (bytes: number) => randomBytes(bytes).toString("hex")

const infraEnvPath = join(root, "infra", ".env")

async function readEnv(path: string): Promise<Record<string, string>> {
  const text = await Bun.file(path).text()
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=")
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      })
  )
}

if (existsSync(infraEnvPath)) {
  console.log("• infra/.env exists, keeping it")
} else {
  // A uniformly random 32-byte scalar is a valid secp256k1 private key
  // (the chance of it being >= the curve order is ~2^-128).
  const values = {
    POSTGRES_PASSWORD: hex(16),
    POSTGRES_PORT: "5442",
    PDS_JWT_SECRET: hex(16),
    PDS_ADMIN_PASSWORD: hex(16),
    PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: hex(32),
  }
  await Bun.write(
    infraEnvPath,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  )
  console.log("✓ wrote infra/.env")
}

const infraEnv = await readEnv(infraEnvPath)
const substitutions: Record<string, string> = {
  __POSTGRES_PASSWORD__: infraEnv.POSTGRES_PASSWORD ?? "",
  __POSTGRES_PORT__: infraEnv.POSTGRES_PORT ?? "5442",
  __PDS_ADMIN_PASSWORD__: infraEnv.PDS_ADMIN_PASSWORD ?? "",
  __ADMIN_TOKEN__: hex(16),
}

for await (const example of new Glob("{apps,packages}/*/.env.example").scan(
  root
)) {
  const target = join(root, example.replace(/\.example$/, ""))
  if (existsSync(target)) {
    console.log(`• ${example.replace(/\.example$/, "")} exists, keeping it`)
    continue
  }
  let text = await Bun.file(join(root, example)).text()
  for (const [placeholder, value] of Object.entries(substitutions)) {
    text = text.replaceAll(placeholder, value)
  }
  await Bun.write(target, text)
  console.log(`✓ wrote ${example.replace(/\.example$/, "")}`)
}
