// The consent prompt before an attachment goes to the provider: who may
// answer it and how long it stays open.
import { randomBytes } from 'node:crypto'
import type { Attachment, Client, Message } from '@mnema-xyz/bot-sdk'
import { LruMap } from '../engine/memory.ts'
import { consentButtons, consentPromptText, type AttachmentClassification } from './attachments.ts'
import { NO_PINGS, type Where } from './chat.ts'
import type { BotSettings } from './settings.ts'

export interface ConsentRecord {
  askerId: string
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

  /** Posts the prompt with Yes and No; after CONSENT_MS its buttons go. */
  async ask(m: Message, threadId: string | undefined, where: Where, attachment: Attachment, classification: AttachmentClassification): Promise<void> {
    const consentId = randomBytes(9).toString('base64url')
    const sentMsg = await this.client.rest.createMessage(m.channel_id, {
      content: consentPromptText(classification, this.shownProvider(), this.isLocal()),
      ...where,
      components: consentButtons(consentId),
      allowed_mentions: NO_PINGS,
    })
    const timer = setTimeout(() => {
      this.open.delete(consentId)
      if (sentMsg.id) {
        void this.client.rest.editMessage(m.channel_id, sentMsg.id, { components: [] }).catch(() => undefined)
      }
    }, CONSENT_MS)
    timer.unref()
    this.open.set(consentId, {
      askerId: m.user_id,
      askerName: m.display_name || m.username,
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
