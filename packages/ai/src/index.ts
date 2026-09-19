import Anthropic from "@anthropic-ai/sdk"

/**
 * Model choices per task. Resume parsing (G2) is high-volume structured
 * extraction; the recruiting agent (G3) does multi-step tool use.
 */
export const MODELS = {
  resumeParser: "claude-sonnet-5",
  recruitingAgent: "claude-opus-5",
} as const

let client: Anthropic | undefined

/** Lazily constructed so services without ANTHROPIC_API_KEY still boot. */
export function getAnthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set")
    }
    client = new Anthropic()
  }
  return client
}
