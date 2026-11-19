// Posting to Mnema Talk: where an answer goes, the split into messages, the
// thinking reaction and the mention in a question. Shared by the mention and
// the interaction paths.
import type { AllowedMentions, Client, Message, MessageComponents } from '@mnema-xyz/bot-sdk'
import { splitMessage } from '../engine/split.ts'

/** Mnemo never notifies anyone: no @username, role, @all or @here pings. */
export const NO_PINGS: AllowedMentions = { parse: [] }

const THINKING = '👀'

/** A reply in a thread, or a reply to a message. */
export type Where = { parent_id: string } | { message_reference: { message_id: string } }

/** Components under an answer: one row of buttons. */
export type Buttons = MessageComponents

export function whereFor(m: Message, threadId: string | undefined): Where {
  return threadId ? { parent_id: threadId } : { message_reference: { message_id: m.id } }
}

/** Posts text in as many messages as it needs; the buttons go under the last. */
export async function post(client: Client, channelId: string, text: string, components: Buttons | undefined, where: Where): Promise<void> {
  const parts = splitMessage(text)
  for (const [n, content] of parts.entries()) {
    const last = n === parts.length - 1
    await client.rest.createMessage(channelId, {
      content,
      ...(n === 0 || 'parent_id' in where ? where : {}),
      ...(last && components ? { components } : {}),
      allowed_mentions: NO_PINGS,
    })
  }
}

export async function react(client: Client, m: Message, on: boolean): Promise<void> {
  try {
    if (on) await client.rest.addReaction(m.channel_id, m.id, THINKING)
    else await client.rest.removeReaction(m.channel_id, m.id, THINKING)
  } catch {
    // Reacting is a courtesy; without the permission Mnemo still answers.
  }
}

/** Removes "@mnemo" from the question; the model does not need it. The
 * mention picker writes the handle (`@bot-…`); people also type the display
 * name by hand. READY carries both. */
export function stripMention(content: string, names: string[]): string {
  let s = content
  for (const name of names) {
    if (!name) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,:;!?])`, 'gi'), ' ')
  }
  return s.replace(/\s+/g, ' ').trim()
}

/** One task at a time per key (a thread), so answers keep their order. */
export class Serial {
  private readonly queues = new Map<string, Promise<void>>()

  /** Runs fn after the key's earlier tasks; a failure of one does not stop the next. */
  async run(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(key, tail)
    try {
      await next
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }
}
