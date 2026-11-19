// The consent prompt before an attachment goes to the provider: who may
// answer it and how long it stays open.
import { randomBytes } from 'node:crypto'
import type { Attachment, Client, Message } from '@mnema-xyz/bot-sdk'
import { LruMap } from '../engine/memory.ts'
import { consentButtons, consentPromptText, type AttachmentClassification } from './attachments.ts'
import { NO_PINGS, type Where } from './chat.ts'
import type { BotSettings } from './settings.ts'

/** The file a question is about, and whose message it came with. */
export interface FoundAttachment {
  attachment: Attachment
  /** Who posted the message the file is on: the asker, or the author of the
   * message the question replies to. */
  ownerId: string
  ownerName: string
  /** Attachments on that message; Mnemo reads only the first. */
  total: number
}

/** A file name as it goes into the prompt: one line, short, no code marks. */
function shownName(a: Attachment): string {
  const name = (a.original_filename || a.filename || 'the file').replace(/[\p{C}`]+/gu, ' ').trim()
  return name.length > 80 ? `${name.slice(0, 79)}…` : name
}

/** A member's name as it goes into a message: one line of at most 64
 * characters (whole graphemes, so emoji are not split), every ASCII punctuation mark escaped, so the name shows as typed
 * and formats nothing. Talk resolves the escapes before it finds mentions,
 * custom emoji and wiki links in the text, so a word joiner (U+2060) follows
 * each @, < and [ as well. Control and format characters go, except the zero
 * width joiner that joined emoji need. */
export function shownMemberName(name: string): string {
  const line = name.replace(/(?:(?!\u200D)\p{C})+/gu, ' ').trim()
  const chars = Array.from(new Intl.Segmenter().segment(line), (g) => g.segment)
  const short = chars.length > 64 ? `${chars.slice(0, 63).join('')}…` : chars.join('')
  return short.replace(/[!-/:-@[-`{-~]/g, (ch) => (ch === '@' || ch === '<' || ch === '[' ? `\\${ch}\u2060` : `\\${ch}`))
}

/** Which file the prompt is about and whose it is, before the question. */
export function consentSubject(found: FoundAttachment, askerId: string): string {
  const name = `\`${shownName(found.attachment)}\``
  const whose = found.ownerId === askerId ? `your file ${name}` : `${name}, a file ${shownMemberName(found.ownerName)} posted`
  const more = found.total > 1 ? ` I read only this one of the ${found.total} attachments on that message.` : ''
  return `You asked about ${whose}.${more}`
}

/** What the prompt says once it can no longer be answered. */
export const EXPIRED_TEXT = 'This question has expired, so I did not look at the file. Ask me again if you still want me to check it.'

export interface ConsentRecord {
  askerId: string
  /** As shownMemberName gives it. */
  askerName: string
  channelId: string
  threadId?: string | undefined
  message: Message
  attachment: Attachment
  classification: AttachmentClassification
  consentMessageId?: string | undefined
  timer?: NodeJS.Timeout | undefined
}

/** How long a consent prompt can be answered. */
const CONSENT_MS = 10 * 60_000

export class Consents {
  private readonly open = new LruMap<ConsentRecord>(1000, CONSENT_MS)
  private readonly client: Client
  private readonly providerName: string
  private readonly s: BotSettings

  /** providerName is the engine's (anthropic, openai, openai-compatible, ...). */
  constructor(client: Client, providerName: string, settings: BotSettings) {
    this.client = client
    this.providerName = providerName
    this.s = settings
  }

  get size(): number {
    return this.open.size
  }

  get(consentId: string): ConsentRecord | undefined {
    return this.open.get(consentId)
  }

  /** Closes a prompt: its buttons no longer answer. */
  drop(consentId: string, consent: ConsentRecord): void {
    if (consent.timer) clearTimeout(consent.timer)
    this.open.delete(consentId)
  }

  /** Posts the prompt with Yes and No; after CONSENT_MS its buttons go and
   * it says that it expired. */
  async ask(m: Message, threadId: string | undefined, where: Where, found: FoundAttachment, classification: AttachmentClassification): Promise<void> {
    const consentId = randomBytes(9).toString('base64url')
    const { attachment } = found
    const sentMsg = await this.client.rest.createMessage(m.channel_id, {
      content: `${consentSubject(found, m.user_id)} ${consentPromptText(classification, this.shownProvider(), this.isLocal())}`,
      ...where,
      components: consentButtons(consentId),
      allowed_mentions: NO_PINGS,
    })
    const timer = setTimeout(() => {
      this.open.delete(consentId)
      if (sentMsg.id) {
        void this.client.rest.editMessage(m.channel_id, sentMsg.id, { content: EXPIRED_TEXT, components: [] }).catch(() => undefined)
      }
    }, CONSENT_MS)
    timer.unref()
    this.open.set(consentId, {
      askerId: m.user_id,
      askerName: shownMemberName(m.display_name || m.username),
      channelId: m.channel_id,
      threadId,
      message: m,
      attachment,
      classification,
      consentMessageId: sentMsg.id,
      timer,
    })
  }

  /** The provider as the prompt names it. */
  private shownProvider(): string {
    const configured = this.s.attachments?.providerName
    if (configured !== undefined) return configured
    if (this.providerName === 'anthropic') return 'Anthropic'
    return this.providerName === 'openai' ? 'OpenAI' : 'the AI provider'
  }

  private isLocal(): boolean {
    return this.s.attachments?.local ?? (this.providerName === 'openai-compatible' && !this.s.attachments?.providerName)
  }
}
