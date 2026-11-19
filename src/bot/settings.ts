// What the chat side of Mnemo is configured with (from Config, in main.ts).
import type { ThreadLimits } from '../engine/memory.ts'

export interface BotSettings {
  /** Channel IDs Mnemo answers in; empty means all it can see. */
  allowedChannels: string[]
  /** User IDs that may run /details and regenerate answers; optional (administrators always have access). */
  adminUserIds: string[]
  /** Regenerations per answer; 0 removes the button. */
  maxRegenerations: number
  /** Answer a mention in a new thread under the question (else as a reply). */
  replyInThread: boolean
  sendDisplayName: boolean
  thread: ThreadLimits & { ttlMs: number }
  vision?: boolean | undefined
  attachments?: {
    enabled: boolean
    maxBytes: number
    askConsent: boolean
    providerName?: string | undefined
    local?: boolean | undefined
  } | undefined
}

/** The attachment size limit; 10 MB unless configured. */
export function maxAttachmentBytes(s: BotSettings): number {
  return s.attachments?.maxBytes ?? 10 * 1024 * 1024
}
