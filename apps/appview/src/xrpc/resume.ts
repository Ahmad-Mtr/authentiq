import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { verifyServiceAuth } from "../auth.ts"
import { deleteDraft, getDraft, saveDraft } from "../resume/drafts.ts"
import {
  MAX_RESUME_BYTES,
  MIME_TYPES,
  ResumeFileError,
  extractResumeText,
  readCapped,
  sniffResumeType,
} from "../resume/extract.ts"
import { parseResumeText } from "../resume/parse.ts"

const RESUME = sh.authentiq.resume

/**
 * sh.authentiq.resume.{uploadResume,getDraft,deleteDraft}
 *
 * Resume parsing lives here, not on the PDS, because repo blobs are public
 * (ADR 0001). Every route needs service auth for its own method. Resume
 * contents are never logged: log lines carry the DID, sizes and counts only.
 */

/** Each parse costs a model call, so uploads are rate limited per user. */
const UPLOADS_PER_HOUR = 10
const uploads = new Map<string, Array<number>>()
function allowUpload(did: string) {
  const since = Date.now() - 60 * 60 * 1000
  const recent = (uploads.get(did) ?? []).filter((at) => at > since)
  if (recent.length >= UPLOADS_PER_HOUR) return false
  uploads.set(did, [...recent, Date.now()])
  return true
}

const unauthorized = (auth: { error: string; message: string }) =>
  status(401, auth)

const view = (id: string, expiresAt: Date, draft: unknown) =>
  RESUME.defs.draftView.parse({
    id,
    expiresAt: expiresAt.toISOString(),
    draft,
  })

export const resume = new Elysia()
  .post(
    `/xrpc/${RESUME.uploadResume.$lxm}`,
    async ({ request, headers }) => {
      const auth = await verifyServiceAuth(
        headers.authorization,
        RESUME.uploadResume.$lxm
      )
      if (!("did" in auth)) return unauthorized(auth)
      const { did } = auth

      if (Number(headers["content-length"] ?? 0) > MAX_RESUME_BYTES) {
        return status(413, {
          error: "FileTooLarge",
          message: `Resumes are limited to ${MAX_RESUME_BYTES / 1024 / 1024} MB`,
        })
      }
      if (!allowUpload(did)) {
        return status(429, {
          error: "RateLimitExceeded",
          message: `At most ${UPLOADS_PER_HOUR} resume uploads per hour`,
        })
      }

      const started = performance.now()
      try {
        // The file and its text exist only in this scope, in memory.
        const bytes = await readCapped(request.body)
        const type = sniffResumeType(bytes)
        if (!type) {
          throw new ResumeFileError(
            "UnsupportedFileType",
            "Only PDF and DOCX resumes are supported"
          )
        }
        const declared = headers["content-type"]?.split(";")[0]?.trim()
        if (
          declared &&
          declared !== "application/octet-stream" &&
          declared !== MIME_TYPES[type]
        ) {
          throw new ResumeFileError(
            "UnsupportedFileType",
            `Declared ${declared}, but the file is a ${type.toUpperCase()}`
          )
        }
        const text = await extractResumeText(bytes, type)
        const { draft, usage } = await parseResumeText(text)
        const { id, expiresAt } = await saveDraft(did, draft)

        console.log(
          `[resume] parsed ${type} (${bytes.byteLength} B) for ${did} in ${Math.round(performance.now() - started)} ms: ` +
            `${draft.positions.length} position(s), ${draft.education.length} education, ` +
            `${usage.promptTokens}+${usage.completionTokens} tokens on ${usage.model}`
        )
        return view(id, expiresAt, draft)
      } catch (err) {
        if (err instanceof ResumeFileError) {
          return status(err.error === "FileTooLarge" ? 413 : 400, {
            error: err.error,
            message: err.message,
          })
        }
        // Only the error's type goes to the log: provider and library errors
        // can echo request content.
        console.error(
          `[resume] parse failed for ${did}: ${(err as Error).name}`,
          (err as { statusCode?: number }).statusCode ?? ""
        )
        return status(502, {
          error: "ParseFailed",
          message:
            "The resume could not be parsed. Try again, or add entries by hand.",
        })
      }
    },
    // The body is read by hand, capped, from the raw stream.
    { parse: "none" }
  )
  .get(
    `/xrpc/${RESUME.getDraft.$lxm}`,
    async ({ query, headers }) => {
      const auth = await verifyServiceAuth(
        headers.authorization,
        RESUME.getDraft.$lxm
      )
      if (!("did" in auth)) return unauthorized(auth)
      const row = await getDraft(auth.did, query.id)
      if (!row) {
        return status(400, {
          error: "DraftNotFound",
          message: "This draft does not exist or has expired",
        })
      }
      return view(row.id, row.expiresAt, row.draft)
    },
    { query: t.Object({ id: t.String({ maxLength: 64 }) }) }
  )
  .post(
    `/xrpc/${RESUME.deleteDraft.$lxm}`,
    async ({ body, headers }) => {
      const auth = await verifyServiceAuth(
        headers.authorization,
        RESUME.deleteDraft.$lxm
      )
      if (!("did" in auth)) return unauthorized(auth)
      return { deleted: await deleteDraft(auth.did, body.id) }
    },
    { body: t.Object({ id: t.String({ maxLength: 64 }) }) }
  )
