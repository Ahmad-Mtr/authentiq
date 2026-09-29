/**
 * Signs a user in to the web app headlessly and returns a fetch bound to
 * their session cookie. The same flow `verify-oauth.ts` checks step by step:
 * login form → PAR → PDS consent API → callback. Throws on any failure.
 */

const API = "/@atproto/oauth-provider/~api"

const NAVIGATE = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
}
const XHR = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "same-origin",
  "sec-fetch-dest": "empty",
}

export async function signInToWeb(opts: {
  web: string
  pds: string
  handle: string
  password: string
}) {
  const jars = new Map<string, Map<string, string>>()
  const jar = (url: string) => {
    const origin = new URL(url).origin
    let j = jars.get(origin)
    if (!j) jars.set(origin, (j = new Map()))
    return j
  }
  const visit = async (url: string, init: RequestInit = {}) => {
    const j = jar(url)
    const cookie = [...j].map(([k, v]) => `${k}=${v}`).join("; ")
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers as Record<string, string>),
        ...(cookie ? { cookie } : {}),
      },
    })
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";")
      const i = pair!.indexOf("=")
      j.set(pair!.slice(0, i), pair!.slice(i + 1))
    }
    return res
  }
  const fail = (step: string, detail: unknown) => {
    throw new Error(`web sign-in failed at ${step}: ${String(detail)}`)
  }

  const login = await visit(`${opts.web}/api/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle: opts.handle }).toString(),
  })
  const authorizeUrl = login.headers.get("location")
  if (!authorizeUrl) fail("login", login.status)

  await visit(authorizeUrl!, { headers: NAVIGATE })
  const apiHeaders = {
    "content-type": "application/json",
    "x-csrf-token": jar(opts.pds).get("csrf-token") ?? "",
    referer: authorizeUrl!,
    ...XHR,
  }
  const signIn = await visit(`${opts.pds}${API}/sign-in`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      locale: "en",
      username: opts.handle,
      password: opts.password,
      remember: true,
    }),
  })
  const did = ((await signIn.json()) as { account?: { did?: string } }).account
    ?.did
  if (!did) fail("sign-in", signIn.status)

  const consent = await visit(`${opts.pds}${API}/consent`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ did }),
  })
  const { url } = (await consent.json()) as { url?: string }
  if (!url) fail("consent", consent.status)

  const bounce = await visit(url!, {
    headers: {
      ...NAVIGATE,
      "sec-fetch-site": "same-origin",
      origin: new URL(opts.pds).origin,
      referer: authorizeUrl!,
    },
  })
  const callbackUrl = bounce.headers.get("location")
  if (!callbackUrl) fail("redirect", bounce.status)
  const callback = await visit(callbackUrl!, { headers: NAVIGATE })
  if (callback.status !== 303 || !jar(opts.web).get("authentiq_session")) {
    fail("callback", callback.status)
  }

  return {
    did: did!,
    /** fetch against the web app, carrying the session cookie. */
    fetch: (path: string, init: RequestInit = {}) =>
      visit(`${opts.web}${path}`, init),
  }
}
