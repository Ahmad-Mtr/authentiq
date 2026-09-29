import mammoth from "mammoth"
import { extractText, getDocumentProxy } from "unpdf"

/**
 * Resume files: read, identify, extract text. Everything here happens in
 * memory. Nothing is written to disk, and callers drop the bytes and the text
 * as soon as the parser has run (ADR 0001: raw resumes are never stored).
 */

export const MAX_RESUME_BYTES = 5 * 1024 * 1024
/** A resume, not a book: bounds pdf.js work and model cost. */
const MAX_PDF_PAGES = 10
/** About 10k tokens. Longer text is cut, not rejected. */
const MAX_TEXT_CHARS = 40_000
/** Below this, the file is almost certainly scanned images. */
const MIN_TEXT_CHARS = 50

export type ResumeFileType = "pdf" | "docx"

export const MIME_TYPES: Record<ResumeFileType, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

export class ResumeFileError extends Error {
  constructor(
    readonly error: "UnsupportedFileType" | "FileTooLarge" | "NoTextFound",
    message: string
  ) {
    super(message)
  }
}

/**
 * Reads a request body into memory, aborting as soon as it passes `max`
 * bytes, so an oversized upload is never buffered whole.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max = MAX_RESUME_BYTES
): Promise<Uint8Array> {
  if (!body) throw new ResumeFileError("UnsupportedFileType", "Empty body")
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > max) {
      await body.cancel().catch(() => {})
      throw new ResumeFileError(
        "FileTooLarge",
        `Resumes are limited to ${max / 1024 / 1024} MB`
      )
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const startsWith = (bytes: Uint8Array, magic: string) =>
  bytes.length >= magic.length &&
  [...magic].every((c, i) => bytes[i] === c.charCodeAt(0))

/**
 * The file type from its bytes; the name and declared content type are not
 * trusted. A DOCX is a ZIP whose entry names are stored uncompressed, so a
 * `word/document.xml` entry distinguishes it from any other ZIP (xlsx, jar…).
 */
export function sniffResumeType(bytes: Uint8Array): ResumeFileType | undefined {
  if (startsWith(bytes, "%PDF-")) return "pdf"
  if (
    startsWith(bytes, "PK\x03\x04") &&
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
      "word/document.xml"
    )
  ) {
    return "docx"
  }
  return undefined
}

/** Plain text of a PDF or DOCX, whitespace-normalised and length-capped. */
export async function extractResumeText(
  bytes: Uint8Array,
  type: ResumeFileType
): Promise<string> {
  let raw: string
  try {
    raw = type === "pdf" ? await pdfText(bytes) : await docxText(bytes)
  } catch (err) {
    if (err instanceof ResumeFileError) throw err
    // Library errors can quote document content, so only the type is kept.
    throw new ResumeFileError(
      "UnsupportedFileType",
      `Could not read this ${type.toUpperCase()} file`
    )
  }
  const text = raw
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (text.length < MIN_TEXT_CHARS) {
    throw new ResumeFileError(
      "NoTextFound",
      "No text found. Scanned or image-only resumes are not supported."
    )
  }
  return text.slice(0, MAX_TEXT_CHARS)
}

async function pdfText(bytes: Uint8Array) {
  // pdf.js may detach the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ResumeFileError(
        "UnsupportedFileType",
        `Resumes are limited to ${MAX_PDF_PAGES} pages`
      )
    }
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  } finally {
    await pdf.loadingTask.destroy()
  }
}

async function docxText(bytes: Uint8Array) {
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  })
  return value
}
