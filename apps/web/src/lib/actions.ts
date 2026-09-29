/**
 * Browser calls to the phase 6 write routes (routes/api.*.ts). They are
 * plain JSON API routes rather than server functions so that
 * `bun run verify:social` can exercise the same write path.
 */
export async function postJson<T = unknown>(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as {
    message?: string
  } & T
  if (!res.ok) throw new Error(json.message ?? `Request failed (${res.status})`)
  return json
}

/** Route params for a post's page, from its AT-URI. */
export function postParams(uri: string) {
  const [, , actor, , rkey] = uri.split("/")
  return { actor: actor, rkey: rkey }
}

/** Route params for a community's page, from its AT-URI. */
export const communityParams = postParams

/** The DID a record URI belongs to; a community URI names its creator. */
export const repoOf = (uri: string) => uri.split("/")[2]
