import { describe, expect, test } from "bun:test"
import {
  BlockedUrlError,
  blockedAddressReason,
  checkUrl,
  createGuardedFetch,
  parseAllowlist,
} from "./fetch-guard.ts"

describe("blockedAddressReason", () => {
  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe", // 169.254.169.254, hex form
    "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
    "2002:a00:1::", // 6to4 of 10.0.0.1
  ])("refuses %s", (ip) => {
    expect(blockedAddressReason(ip)).toBeString()
  })

  test.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"])(
    "allows %s",
    (ip) => {
      expect(blockedAddressReason(ip)).toBeUndefined()
    }
  )
})

describe("checkUrl", () => {
  const allow = parseAllowlist("localhost:2585, localhost:2590-2593")

  test("refuses the metadata address and private literals without a lookup", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/.well-known/did.json",
      "https://[::1]:2585/",
    ]) {
      await expect(checkUrl(url, allow)).rejects.toBeInstanceOf(BlockedUrlError)
    }
  })

  test("refuses http unless allowlisted, and allowlists ports, not hosts", async () => {
    await expect(checkUrl("http://example.com/", allow)).rejects.toThrow(/http/)
    await expect(checkUrl("http://localhost:5442/", allow)).rejects.toThrow()
    await expect(checkUrl("https://localhost/", allow)).rejects.toThrow()
    expect(await checkUrl("http://localhost:2585/x", allow)).toBeInstanceOf(URL)
    expect(await checkUrl("http://localhost:2592/x", allow)).toBeInstanceOf(URL)
    await expect(checkUrl("http://localhost:2594/x", allow)).rejects.toThrow()
  })

  test("refuses names that resolve to loopback", async () => {
    await expect(checkUrl("https://localhost:2599/", allow)).rejects.toThrow(/range/)
  })

  test("refuses other schemes and credentials", async () => {
    await expect(checkUrl("file:///etc/passwd", allow)).rejects.toThrow(/scheme/)
    await expect(checkUrl("http://u:p@localhost:2585/", allow)).rejects.toThrow(
      /credentials/
    )
  })
})

describe("createGuardedFetch", () => {
  test("caps the body, refuses redirects, and makes no request to a blocked URL", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        hits++
        const path = new URL(req.url).pathname
        if (path === "/big") return new Response("x".repeat(2000))
        if (path === "/redirect") {
          return Response.redirect("http://169.254.169.254/", 302)
        }
        return Response.json({ ok: true })
      },
    })
    const allow = parseAllowlist(`localhost:${server.port}`)
    const guarded = createGuardedFetch({ allow, maxBytes: 1000 })
    const base = `http://localhost:${server.port}`
    expect(await (await guarded(`${base}/ok`)).json()).toEqual({ ok: true })
    await expect(guarded(`${base}/big`)).rejects.toThrow(/larger/)
    await expect(guarded(`${base}/redirect`)).rejects.toThrow(/redirect/)
    const before = hits
    // Same server, reached by another name that is not allowlisted.
    await expect(guarded(`http://127.0.0.1:${server.port}/ok`)).rejects.toThrow()
    await Bun.sleep(20)
    expect(hits).toBe(before)
    server.stop(true)
  })
})
