import { randomBytes } from "node:crypto"
import type { ChatMessage } from "@workspace/ai"

/**
 * Agent conversations, in AppView memory only: never written to Postgres or
 * a repo, gone after 30 idle minutes or a restart. A conversation belongs to
 * the DID that started it.
 *
 * `toolUris` is every candidate or job posting URI a tool returned in this
 * conversation: the only URIs the agent may cite.
 */

const TTL_MS = 30 * 60 * 1000
export const MAX_TURNS = 12
/** Model context: the last few turns, whole, so tool calls stay paired with their results. */
const CONTEXT_TURNS = 6

/** Something the agent may cite: a candidate's profile, or a job posting. */
export type Candidate = {
  /** Absent means "actor" (phase 5 conversations only had candidates). */
  kind?: "actor" | "job"
  uri: string
  /** The candidate, or the posting's author. */
  did: string
  handle: string
  /** The candidate's name, or the posting's title. */
  displayName?: string
}

export type Conversation = {
  id: string
  did: string
  turns: Array<Array<ChatMessage>>
  toolUris: Map<string, Candidate>
  expiresAt: number
}

const conversations = new Map<string, Conversation>()

function sweep() {
  const now = Date.now()
  for (const [id, c] of conversations)
    if (c.expiresAt < now) conversations.delete(id)
}

/** A new conversation, or the caller's existing one; undefined if unknown or someone else's. */
export function openConversation(
  did: string,
  id?: string
): Conversation | undefined {
  sweep()
  if (id) {
    const c = conversations.get(id)
    if (!c || c.did !== did) return undefined
    c.expiresAt = Date.now() + TTL_MS
    return c
  }
  const c: Conversation = {
    id: randomBytes(12).toString("base64url"),
    did,
    turns: [],
    toolUris: new Map(),
    expiresAt: Date.now() + TTL_MS,
  }
  conversations.set(c.id, c)
  return c
}

export const contextMessages = (c: Conversation) =>
  c.turns.slice(-CONTEXT_TURNS).flat()
