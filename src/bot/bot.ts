// Mnemo on Mnema Talk: answers mentions, /ask and messages in the threads it
// started, with Regenerate and Follow-up buttons and an admin-only /details.
// The chat-specific code is in src/bot; the answering itself is the Engine's.
// This file wires the events and owns the mention and attachment path;
// interactions.ts has /ask, /details and the answer buttons.
import { ActivityType, RestError, type Attachment, type Client, type Interaction, type Message } from '@mnema-xyz/bot-sdk'
import type { Engine } from '../engine/engine.ts'
import { OncePerWindow, type Budget } from '../engine/limits.ts'
import { boundHistory, LruMap, type HistoryTurn } from '../engine/memory.ts'
import type { Logger } from '../log.ts'
import type { MediaAttachment } from '../providers/types.ts'
import { AnswerStore } from './answers.ts'
import { attachmentRefusal, convertFile, downloadFile, type ReaderDeps } from './attachment-reader.ts'
import { classifyAttachment, type AttachmentClassification } from './attachments.ts'
import { NO_PINGS, post, react, Serial, stripMention, whereFor, type Where } from './chat.ts'
import { commandsFor } from './commands.ts'
import { Consents } from './consent.ts'
import { Interactions } from './interactions.ts'
import { maxAttachmentBytes, type BotSettings } from './settings.ts'

export type { BotSettings } from './settings.ts'

const attachmentsOf = (m: Message) => (m as { attachments?: Attachment[] }).attachments ?? []

export class MnemoBot {
  private selfId = ''
  private selfName = ''
  private selfHandle = ''
  private readonly threads: LruMap<HistoryTurn[]>
  private readonly answers: AnswerStore
  private readonly consents: Consents
  private readonly interactions: Interactions
  /** Who was already told about a limit in this window. */
  private readonly told = new OncePerWindow()
  /** One question at a time per thread, so answers keep their order. */
  private readonly queues = new Serial()

  private readonly client: Client
  private readonly engine: Engine
  private readonly s: BotSettings
  private readonly log: Logger

  constructor(client: Client, engine: Engine, budget: Budget, settings: BotSettings, log: Logger) {
    this.client = client
    this.engine = engine
    this.s = settings
    this.log = log
    this.threads = new LruMap(1000, settings.thread.ttlMs)
    this.answers = new AnswerStore(budget, settings, log)
    this.consents = new Consents(client, engine.providerName, settings)
    this.interactions = new Interactions({
      client,
      engine,
      s: settings,
      log,
      answers: this.answers,
      threads: this.threads,
      serial: (key, fn) => this.serial(key, fn),
      allowed: (channelId) => this.allowed(channelId),
      onConsent: (i, kind, consentId) => this.onConsent(i, kind, consentId),
    })

    client.on('ready', (r) => {
      this.selfId = r.user.id
      this.selfName = r.user.username
      this.selfHandle = r.user.handle ?? ''
      log.info('ready', { bot: r.user.username, handle: r.user.handle, session: r.session_id })
      void this.afterReady()
    })
    client.on('messageCreate', (m) => {
      void this.onMessage(m).catch((err: unknown) => {
        this.log.error('message_failed', { error: err })
      })
    })
    client.on('interactionCreate', (i) => {
      void this.interactions.handle(i).catch((err: unknown) => {
        this.log.error('interaction_failed', { error: err })
      })
    })
  }

  private async afterReady(): Promise<void> {
    try {
      await this.client.commands.set(commandsFor(this.s.adminUserIds))
      this.client.setPresence({ status: 'online', activity: { type: ActivityType.Custom, name: 'Ask me: /ask or @mention' } })
    } catch (err) {
      this.log.warn('setup_failed', { error: err })
    }
  }

  private allowed(channelId: string): boolean {
    return this.s.allowedChannels.length === 0 || this.s.allowedChannels.includes(channelId)
  }

  /** A message Mnemo should answer: a mention, or a message in its thread. */
  private addressed(m: Message): boolean {
    if (!this.selfId || m.user_id === this.selfId || m.is_bot) return false
    if (!m.content.trim() && attachmentsOf(m).length === 0) return false
    if (!this.allowed(m.channel_id)) return false
    return m.mentions.includes(this.selfId) || (m.parent_id !== undefined && this.threads.has(m.parent_id))
  }

  // ---- mentions and threads ------------------------------------------------

  private async onMessage(m: Message): Promise<void> {
    if (!this.addressed(m)) return
    // A mention in the channel starts a thread under the question; one inside
    // a thread is answered there.
    const threadId = m.parent_id ?? (this.s.replyInThread ? m.id : undefined)
    const where = whereFor(m, threadId)
    const attachment = await this.findAttachment(m)
    if (attachment) return this.onAttachment(m, threadId, where, attachment)
    if (await this.refusedInChannel(m, where)) return
    await this.serial(threadId ?? m.id, () => this.sendAnswer(m, threadId, this.stripMention(m.content)))
  }

  private async onAttachment(m: Message, threadId: string | undefined, where: Where, attachment: Attachment): Promise<void> {
    const classification = classifyAttachment(attachment)
    const refusal = attachmentRefusal(this.s, attachment, classification)
    if (refusal) return post(this.client, m.channel_id, refusal, undefined, where)
    // A consent prompt counts against the limits like a question, so a flood
    // of attachment mentions neither posts one prompt each nor skips them.
    if (await this.refusedInChannel(m, where)) return
    if (this.s.attachments?.askConsent ?? true) return this.consents.ask(m, threadId, where, attachment, classification)
    await this.serial(threadId ?? m.id, () => this.answerWithAttachment(m, threadId, attachment, classification))
  }

  /** Limits are checked before queueing, so a flood neither queues up nor
   * gets one public refusal per message: the member hears it once. */
  private async refusedInChannel(m: Message, where: Where): Promise<boolean> {
    const refused = this.engine.admit(m.user_id, m.channel_id)
    if (!refused) return false
    if (this.told.first(`${m.user_id}:${refused.reason}`, refused.retryMs)) await post(this.client, m.channel_id, refused.text, undefined, where)
    return true
  }

  /** The message's first attachment, else the first of the message it replies to. */
  private async findAttachment(m: Message): Promise<Attachment | undefined> {
    const own = attachmentsOf(m)
    if (own.length > 0) return own[0]
    const replyId = m.reply_to_id ?? m.reply_to?.id
    if (!replyId) return undefined
    try {
      return attachmentsOf(await this.client.rest.getMessage(m.channel_id, replyId))[0]
    } catch {
      // If fetching the replied-to message fails, answer without it.
      return undefined
    }
  }

  private async onConsent(i: Interaction, kind: 'consent_yes' | 'consent_no', consentId: string): Promise<void> {
    const consent = this.consents.get(consentId)
    if (!consent) {
      await i.reply({ content: 'This question is too old for that now. Ask me again.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    if (i.user.id !== consent.askerId) {
      await i.reply({ content: `Only ${consent.askerName} can answer this.`, ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    if (kind === 'consent_no') {
      this.consents.drop(consentId, consent)
      await i.deferUpdate()
      await i.editReply({ content: "Okay, I won't look at it.", components: [] }).catch(() => undefined)
      return
    }
    // The accepted call is a question of its own: it is admitted before the
    // download. A refused Yes keeps the prompt, so the asker can try again.
    // Admitted and claimed with no await in between, so a double click reads
    // the file once.
    const refused = this.engine.admit(i.user.id, consent.channelId)
    if (refused) {
      await i.reply({ content: refused.text, ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    this.consents.drop(consentId, consent)
    await i.deferUpdate()
    await i.editReply({ components: [] }).catch(() => undefined)
    await this.serial(consent.threadId ?? consent.message.id, () =>
      this.answerWithAttachment(consent.message, consent.threadId, consent.attachment, consent.classification),
    )
  }

  private async answerWithAttachment(m: Message, threadId: string | undefined, attachment: Attachment, classification: AttachmentClassification): Promise<void> {
    const where = whereFor(m, threadId)
    const deps: ReaderDeps = { client: this.client, log: this.log, providerName: this.engine.providerName, maxBytes: maxAttachmentBytes(this.s) }
    await react(this.client, m, true)
    const file = await downloadFile(deps, attachment).finally(() => react(this.client, m, false))
    const read = typeof file === 'string' ? file : await convertFile(deps, attachment, classification, file)
    if (typeof read === 'string') return post(this.client, m.channel_id, read, undefined, where)
    if (!read) return

    let question = this.stripMention(m.content)
    if (read.textPrefix) question = question ? `${read.textPrefix}\n\n${question}` : read.textPrefix
    if (!question) question = classification.type === 'image' ? 'Describe this image.' : 'Describe this file.'
    await this.sendAnswer(m, threadId, question, read.attachments)
  }

  private async sendAnswer(m: Message, threadId: string | undefined, question: string, attachments?: MediaAttachment[]): Promise<void> {
    const known = threadId ? this.threads.get(threadId) : undefined
    const history = known ?? []
    const follow = threadId !== undefined && (threadId === m.id || known !== undefined)
    await react(this.client, m, true)
    try {
      const askerName = m.display_name || m.username
      const result = await this.engine.ask({ question, history, userId: m.user_id, channelId: m.channel_id, askerName, attachments, admitted: true })
      const answerId = this.answers.remember(result, { question, history, askerId: m.user_id, channelId: m.channel_id, threadId, ephemeral: false, regenerations: 0 })
      const components = answerId ? this.answers.buttons(answerId, false, 0) : undefined
      await post(this.client, m.channel_id, result.text, components, whereFor(m, threadId))
      if (follow && result.kind === 'answer') {
        this.threads.set(threadId, boundHistory([...history, { role: 'user', text: question }, { role: 'assistant', text: result.text }], this.s.thread))
      }
    } finally {
      await react(this.client, m, false)
    }
  }

  private stripMention(content: string): string {
    return stripMention(content, [this.selfHandle, this.selfName])
  }

  private async serial(key: string, fn: () => Promise<void>): Promise<void> {
    try {
      await this.queues.run(key, fn)
    } catch (err) {
      // Status, code and route only: a server message can quote the message.
      if (err instanceof RestError) this.log.warn('mnema_api_error', { status: err.status, code: err.code, method: err.method, path: err.path })
      else throw err
    }
  }

  /** For the health endpoint. */
  stats(): Record<string, number> {
    return { threads: this.threads.size, answers: this.answers.size, consents: this.consents.size }
  }
}
