/**
 * Drives the whole phase 2 flow headlessly, the way a browser would:
 *
 *   login form → PAR → PDS consent API → callback → session cookie → pages
 *
 * Needs the web app (`bun run dev`) and the AppView running.
 *
 *   bun run verify:oauth
 */
const WEB = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000"
const PDS = process.env.PDS_URL ?? "http://localhost:2583"
const HANDLE = process.env.VERIFY_HANDLE ?? "alice.test"
const PASSWORD = process.env.VERIFY_PASSWORD ?? "password"
const API = "/@atproto/oauth-provider/~api"

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}

/** Minimal cookie jar: one bag of cookies per origin. */
const jars = new Map<string, Map<string, string>>()
function jar(url: string) {
  const origin = new URL(url).origin
  let j = jars.get(origin)
  if (!j) jars.set(origin, (j = new Map()))
  return j
}
async function visit(url: string, init: RequestInit = {}) {
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

// 1. The login form pushes an authorization request and redirects to the PDS.
const login = await visit(`${WEB}/api/oauth/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ handle: HANDLE }).toString(),
})
const authorizeUrl = login.headers.get("location") ?? ""
check(
  login.status === 303 && authorizeUrl.includes("request_uri="),
  "login redirects to the PDS with a PAR request_uri",
  `${login.status} ${new URL(authorizeUrl || WEB).pathname}`
)
if (!authorizeUrl) process.exit(1)

// The PDS enforces Fetch Metadata headers, so a script has to present itself
// the way a browser would: a top-level navigation for pages, XHR for the API.
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

// 2. Load the consent screen — this is what sets the device and CSRF cookies.
const consentPage = await visit(authorizeUrl, { headers: NAVIGATE })
check(consentPage.ok, "PDS serves the consent screen", String(consentPage.status))

const csrf = jar(PDS).get("csrf-token") ?? ""
check(Boolean(csrf), "CSRF cookie issued")

const apiHeaders = {
  "content-type": "application/json",
  "x-csrf-token": csrf,
  referer: authorizeUrl,
  ...XHR,
}

// 3. Authenticate against the PDS. The password is sent to the user's own
//    server — Authentiq never sees it.
const signIn = await visit(`${PDS}${API}/sign-in`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({
    locale: "en",
    username: HANDLE,
    password: PASSWORD,
    remember: true,
  }),
})
const signInBody = (await signIn.json().catch(() => ({}))) as {
  account?: { did?: string; handle?: string }
  error?: string
}
const did = signInBody.account?.did
check(signIn.ok && Boolean(did), "signed in at the PDS", did ?? signInBody.error ?? "")

// 4. Grant Authentiq access.
const consent = await visit(`${PDS}${API}/consent`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ did }),
})
const consentBody = (await consent.json().catch(() => ({}))) as {
  url?: string
  error?: string
}
check(
  consent.ok && Boolean(consentBody.url),
  "consent granted, redirected back with a code",
  consentBody.error ?? ""
)
if (!consentBody.url) process.exit(1)

// 5. The PDS bounces through its own redirect endpoint (same-origin
//    navigation), which then sends the browser to our callback (cross-site).
const bounce = await visit(consentBody.url, {
  headers: {
    ...NAVIGATE,
    "sec-fetch-site": "same-origin",
    origin: new URL(PDS).origin,
    referer: authorizeUrl,
  },
})
const callbackUrl = bounce.headers.get("location") ?? ""
if (!callbackUrl) {
  console.log(`✗ PDS did not redirect back (${bounce.status})`)
  process.exit(1)
}
check(
  callbackUrl.startsWith(`${WEB}/api/oauth/callback`),
  "PDS redirects back to the Authentiq callback",
  `${bounce.status} ${callbackUrl.split("?")[0]}`
)

// 6. The callback exchanges the code and issues our session cookie.
const callback = await visit(callbackUrl, { headers: NAVIGATE })
check(
  callback.status === 303 && callback.headers.get("location") === "/profile/edit",
  "callback creates a session and redirects to the editor",
  `${callback.status} → ${callback.headers.get("location")}`
)
check(Boolean(jar(WEB).get("authentiq_session")), "session cookie set")

// 7. The editor now loads for the signed-in user, and writes went to the repo.
const editor = await visit(`${WEB}/profile/edit`)
const editorHtml = await editor.text()
check(editor.ok, "profile editor loads while signed in", String(editor.status))
check(
  editorHtml.includes(did ?? "no-did"),
  "editor shows the signed-in user's repo DID"
)

// The session can make authenticated calls to the PDS on the user's behalf.
const whoami = await visit(`${WEB}/api/auth/whoami`)
const who = (await whoami.json().catch(() => ({}))) as {
  did?: string
  handle?: string
}
check(
  whoami.ok && who.did === did && who.handle === HANDLE,
  "session makes an authenticated call to the PDS",
  `${who.handle ?? "?"} / ${who.did ?? "?"}`
)

// 8. The public profile page is served from the AppView, not the PDS.
const profile = await visit(`${WEB}/p/${HANDLE}`)
const profileHtml = await profile.text()
check(profile.ok, "profile page renders via the AppView", String(profile.status))
check(profileHtml.includes(HANDLE), "profile page shows the handle")

// 9. Signing out clears the session.
const logout = await visit(`${WEB}/api/auth/logout`, { method: "POST" })
check(logout.status === 303, "sign out redirects home", String(logout.status))

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
