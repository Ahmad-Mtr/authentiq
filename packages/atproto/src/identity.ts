/**
 * Minimal identity resolution for the local network.
 *
 * `*.test` handles have no DNS or `/.well-known/atproto-did`, so we resolve
 * them by asking the PDS directly. DIDs resolve through the local PLC.
 */

/** A fetch to resolve with; pass the fetch guard for user-named DIDs and hosts. */
type Fetch = (input: URL, init?: RequestInit) => Promise<Response>

export type DidDocument = {
  id: string
  alsoKnownAs?: Array<string>
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>
}

export async function resolveHandle(
  handle: string,
  opts: { pdsUrl: string; fetch?: Fetch }
): Promise<string> {
  const url = new URL("/xrpc/com.atproto.identity.resolveHandle", opts.pdsUrl)
  url.searchParams.set("handle", handle)
  const res = await (opts.fetch ?? fetch)(url)
  if (!res.ok) throw new Error(`Could not resolve handle ${handle}: ${res.status}`)
  const { did } = (await res.json()) as { did: string }
  return did
}

export async function resolveDid(
  did: string,
  opts: { plcUrl: string; fetch?: Fetch }
): Promise<DidDocument> {
  let url: URL
  if (did.startsWith("did:plc:")) {
    url = new URL(`/${did}`, opts.plcUrl)
  } else if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length))
    const scheme = host.startsWith("localhost") ? "http" : "https"
    url = new URL(`${scheme}://${host}/.well-known/did.json`)
  } else {
    throw new Error(`Unsupported DID method: ${did}`)
  }
  const res = await (opts.fetch ?? fetch)(url)
  if (!res.ok) throw new Error(`Could not resolve ${did}: ${res.status}`)
  return (await res.json()) as DidDocument
}

/** The PDS endpoint (`#atproto_pds` service) from a DID document. */
export function getPdsEndpoint(doc: DidDocument): string | undefined {
  return doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.id === `${doc.id}#atproto_pds`
  )?.serviceEndpoint
}

/** The primary handle (`at://` alias) from a DID document. */
export function getHandle(doc: DidDocument): string | undefined {
  return doc.alsoKnownAs
    ?.find((aka) => aka.startsWith("at://"))
    ?.slice("at://".length)
}
