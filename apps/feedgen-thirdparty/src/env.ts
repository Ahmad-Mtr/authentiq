/**
 * A third party's configuration. Note what is not here: no database, no
 * AppView URL, no secret shared with Authentiq. Everything this service
 * knows comes from the public network: the PDS's firehose and repo API.
 */
const e = process.env
export const env = {
  PORT: Number(e.PORT ?? 2586),
  SERVICE_DID: e.SERVICE_DID ?? "did:web:localhost%3A2586",
  PUBLIC_URL: e.PUBLIC_URL ?? "http://localhost:2586",
  PDS_URL: e.PDS_URL ?? "http://localhost:2583",
  PLC_URL: e.PLC_URL ?? "http://localhost:2582",
  PUBLISHER: e.PUBLISHER ?? "link-roundup.test",
}
