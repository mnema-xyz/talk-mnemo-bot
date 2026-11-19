// Mnemo on Mnema Talk: answers mentions, /ask and messages in the threads it
// started, with Regenerate and Follow-up buttons and an admin-only /details. All chat-specific
// code is in this file; the answering itself is the Engine's.
import { randomBytes } from 'node:crypto'
import {
  actionRow,
  ActivityType,
  button,
  ButtonStyle,
  MaxBytesExceededError,
  modal,
  NotFoundError,
  Permissions,
  RestError,
  textInput,
  TextInputStyle,
  type AllowedMentions,
  type Attachment,
  type Client,
  type Interaction,
  type Message,
} from '@mnema-xyz/bot-sdk'
import type { AskResult, Engine } from '../engine/engine.ts'
import { OncePerWindow, type Budget } from '../engine/limits.ts'
import { boundHistory, LruMap, type HistoryTurn, type ThreadLimits } from '../engine/memory.ts'
import { splitMessage } from '../engine/split.ts'
import type { Logger } from '../log.ts'
import type { MediaAttachment } from '../providers/types.ts'
import {
  classifyAttachment,
  consentButtons,
  consentPromptText,
  extractPdfText,
  processImage,
  readStreamWithCap,
  type AttachmentClassification,
} from './attachments.ts'
import { commandsFor } from './commands.ts'
import { customId, detailsFrom, detailsText, parseCustomId, type AnswerDetails } from './delivery.ts'

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

interface ConsentRecord {
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

/** What a button needs to know about the answer it sits under. */
interface AnswerRecord {
  question: string
  answer: string
  history: HistoryTurn[]
  askerId: string
  channelId: string
  /** The thread the answer is in, if any. */
  threadId?: string | undefined
  ephemeral: boolean
  /** How many times this question was regenerated to get this answer. */
  regenerations: number
  details: AnswerDetails
}

/** Mnemo never notifies anyone: no @username, role, @all or @here pings. */
const NO_PINGS: AllowedMentions = { parse: [] }

const THINKING = '👀'
const MAX_ANSWERS = 2000

export class MnemoBot {
  private selfId = ''
  private selfName = ''
  private selfHandle = ''
  private readonly threads: LruMap<HistoryTurn[]>
  private readonly answers = new LruMap<AnswerRecord>(MAX_ANSWERS, 24 * 3600_000)
  private readonly consents = new LruMap<ConsentRecord>(1000, 10 * 60_000)
  /** The last public answer per channel, for /details. */
  private readonly lastAnswer = new LruMap<string>(MAX_ANSWERS, 24 * 3600_000)
  /** Who was already told about a limit in this window. */
  private readonly told = new OncePerWindow()
  /** One question at a time per thread, so answers keep their order. */
  private readonly queues = new Map<string, Promise<void>>()

  private readonly client: Client
  private readonly engine: Engine
  private readonly budget: Budget
  private readonly s: BotSettings
  private readonly log: Logger

  constructor(client: Client, engine: Engine, budget: Budget, settings: BotSettings, log: Logger) {
    this.client = client
    this.engine = engine
    this.budget = budget
    this.s = settings
    this.log = log
    this.threads = new LruMap(1000, settings.thread.ttlMs)

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
      void this.onInteraction(i).catch((err: unknown) => {
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

  // ---- mentions and threads ------------------------------------------------

  private async onMessage(m: Message): Promise<void> {
    if (!this.selfId || m.user_id === this.selfId || m.is_bot) return
    const atts = (m as { attachments?: Attachment[] }).attachments ?? []
    if (!m.content.trim() && atts.length === 0) return
    if (!this.allowed(m.channel_id)) return

    const mentioned = m.mentions.includes(this.selfId)
    const inOurThread = m.parent_id !== undefined && this.threads.has(m.parent_id)
    if (!mentioned && !inOurThread) return

    // A mention in the channel starts a thread under the question; one inside
    // a thread is answered there.
    const threadId = m.parent_id ?? (this.s.replyInThread ? m.id : undefined)
    const where = threadId ? { parent_id: threadId } : { message_reference: { message_id: m.id } }

    const attachment = await this.findAttachment(m)
    if (attachment) {
      if (this.s.attachments?.enabled === false) {
        await this.post(m.channel_id, "I can't read attachments.", undefined, where)
        return
      }
      const size = attachment.size_bytes || (attachment.size ?? 0)
      const maxBytes = this.s.attachments?.maxBytes ?? 10 * 1024 * 1024
      if (size > maxBytes) {
        const mb = (size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')
        await this.post(m.channel_id, `This file is ${mb} MB; I can only read attachments up to 10 MB.`, undefined, where)
        return
      }
      const classification = classifyAttachment(attachment)
      if (classification.type === 'unsupported') {
        await this.post(m.channel_id, `I can't read ${classification.fileType} files yet.`, undefined, where)
        return
      }
      if (classification.type === 'image' && this.s.vision === false) {
        await this.post(m.channel_id, 'The configured model does not support image input.', undefined, where)
        return
      }
      // A consent prompt counts against the limits like a question, so a flood
      // of attachment mentions neither posts one prompt each nor skips them.
      if (await this.refusedInChannel(m, where)) return
      const askConsent = this.s.attachments?.askConsent ?? true
      if (askConsent) {
        await this.askConsent(m, threadId, where, attachment, classification)
        return
      }
      await this.serial(threadId ?? m.id, () => this.answerWithAttachment(m, threadId, attachment, classification))
      return
    }

    if (await this.refusedInChannel(m, where)) return
    await this.serial(threadId ?? m.id, () => this.answerMessage(m, threadId))
  }

  /** Limits are checked before queueing, so a flood neither queues up nor
   * gets one public refusal per message: the member hears it once. */
  private async refusedInChannel(m: Message, where: { parent_id: string } | { message_reference: { message_id: string } }): Promise<boolean> {
    const refused = this.engine.admit(m.user_id, m.channel_id)
    if (!refused) return false
    if (this.told.first(`${m.user_id}:${refused.reason}`, refused.retryMs)) await this.post(m.channel_id, refused.text, undefined, where)
    return true
  }

  private async findAttachment(m: Message): Promise<Attachment | undefined> {
    const atts = (m as { attachments?: Attachment[] }).attachments ?? []
    if (atts.length > 0) return atts[0]
    const replyId = m.reply_to_id ?? m.reply_to?.id
    if (!replyId) return undefined
    try {
      const ref = await this.client.rest.getMessage(m.channel_id, replyId)
      const refAtts = (ref as { attachments?: Attachment[] }).attachments ?? []
      if (refAtts.length > 0) return refAtts[0]
    } catch {
      // If fetching reply fails, ignore
    }
    return undefined
  }

  private async askConsent(
    m: Message,
    threadId: string | undefined,
    where: { parent_id: string } | { message_reference: { message_id: string } },
    attachment: Attachment,
    classification: AttachmentClassification,
  ): Promise<void> {
    const consentId = randomBytes(9).toString('base64url')
    const providerName =
      this.s.attachments?.providerName ??
      (this.engine.providerName === 'anthropic' ? 'Anthropic' : this.engine.providerName === 'openai' ? 'OpenAI' : 'the AI provider')
    const isLocal = this.s.attachments?.local ?? (this.engine.providerName === 'openai-compatible' && !this.s.attachments?.providerName)
    const text = consentPromptText(classification, providerName, isLocal)
    const components = consentButtons(consentId)
    const sentMsg = await this.client.rest.createMessage(m.channel_id, {
      content: text,
      ...where,
      components,
      allowed_mentions: NO_PINGS,
    })
    const timer = setTimeout(() => {
      this.consents.delete(consentId)
      if (sentMsg.id) {
        void this.client.rest.editMessage(m.channel_id, sentMsg.id, { components: [] }).catch(() => undefined)
      }
    }, 10 * 60_000)
    timer.unref()
    this.consents.set(consentId, {
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
      this.dropConsent(consentId, consent)
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
    this.dropConsent(consentId, consent)

    await i.deferUpdate()
    await i.editReply({ components: [] }).catch(() => undefined)
    await this.serial(consent.threadId ?? consent.message.id, () =>
      this.answerWithAttachment(consent.message, consent.threadId, consent.attachment, consent.classification),
    )
  }

  private dropConsent(consentId: string, consent: ConsentRecord): void {
    if (consent.timer) clearTimeout(consent.timer)
    this.consents.delete(consentId)
  }

  private async answerWithAttachment(
    m: Message,
    threadId: string | undefined,
    attachment: Attachment,
    classification: AttachmentClassification,
  ): Promise<void> {
    const where = threadId ? { parent_id: threadId } : { message_reference: { message_id: m.id } }
    const processed = await this.downloadAndProcess(m, attachment, classification, where)
    if (!processed) return

    let question = this.stripMention(m.content)
    if (processed.textPrefix) {
      question = question ? `${processed.textPrefix}\n\n${question}` : processed.textPrefix
    }
    if (!question) {
      question = classification.type === 'image' ? 'Describe this image.' : 'Describe this file.'
    }
    await this.sendAnswer(m, threadId, question, processed.attachments)
  }

  private async downloadAndProcess(
    m: Message,
    attachment: Attachment,
    classification: AttachmentClassification,
    where: { parent_id: string } | { message_reference: { message_id: string } },
  ): Promise<{ attachments?: MediaAttachment[]; textPrefix?: string } | undefined> {
    const maxBytes = this.s.attachments?.maxBytes ?? 10 * 1024 * 1024
    let buffer: Buffer
    let contentType = attachment.content_type || attachment.mime_type
    await this.react(m, true)
    try {
      const downloaded = await this.client.rest.downloadAttachment(attachment.id, {
        maxBytes,
        signal: AbortSignal.timeout(30_000),
      })
      buffer = await readStreamWithCap(downloaded.stream, maxBytes)
      if (downloaded.contentType) contentType = downloaded.contentType
    } catch (err) {
      if (err instanceof NotFoundError) {
        await this.post(m.channel_id, 'Reading attachments requires Talk 3.3 or newer.', undefined, where)
        return undefined
      }
      if (err instanceof MaxBytesExceededError) {
        await this.post(m.channel_id, 'This file is too large; I can only read attachments up to 10 MB.', undefined, where)
        return undefined
      }
      this.log.warn('attachment_download_failed', { error: err })
      await this.post(m.channel_id, 'Sorry, I could not download the attachment. Try again in a moment.', undefined, where)
      return undefined
    } finally {
      await this.react(m, false)
    }

    this.log.info('attachment_read', { type: contentType, size: buffer.length })

    if (classification.type === 'image') {
      try {
        const processed = await processImage(buffer, contentType)
        return { attachments: [{ type: 'image', mediaType: processed.mediaType, data: processed.data }] }
      } catch (err) {
        this.log.warn('image_processing_failed', { error: err })
        await this.post(m.channel_id, 'Sorry, I could not process that image.', undefined, where)
        return undefined
      }
    }
    if (classification.type === 'pdf') {
      if (this.engine.providerName === 'anthropic') {
        return { attachments: [{ type: 'document', mediaType: 'application/pdf', data: buffer.toString('base64') }] }
      }
      const extracted = extractPdfText(buffer)
      const fname = attachment.original_filename || attachment.filename || 'document.pdf'
      return { textPrefix: `Attachment (${fname}):\n${extracted || '[No extractable text]'}` }
    }
    if (classification.type === 'text') {
      let text = buffer.toString('utf-8')
      if (text.length > 40_000) text = `${text.slice(0, 40_000)}\n\n[... content truncated ...]`
      const fname = attachment.original_filename || attachment.filename || 'file'
      return { textPrefix: `Attachment (${fname}):\n\`\`\`\n${text}\n\`\`\`` }
    }
    return undefined
  }

  private async sendAnswer(
    m: Message,
    threadId: string | undefined,
    question: string,
    attachments?: MediaAttachment[],
  ): Promise<void> {
    const known = threadId ? this.threads.get(threadId) : undefined
    const history = known ?? []
    const follow = threadId !== undefined && (threadId === m.id || known !== undefined)
    await this.react(m, true)
    try {
      const result = await this.engine.ask({
        question,
        history,
        userId: m.user_id,
        channelId: m.channel_id,
        askerName: m.display_name || m.username,
        attachments,
        admitted: true,
      })
      const answerId = this.remember(result, { question, history, askerId: m.user_id, channelId: m.channel_id, threadId, ephemeral: false, regenerations: 0 })
      const components = answerId ? this.buttons(answerId, false, 0) : undefined
      await this.post(m.channel_id, result.text, components, threadId ? { parent_id: threadId } : { message_reference: { message_id: m.id } })
      if (follow && result.kind === 'answer') {
        this.threads.set(threadId, boundHistory([...history, { role: 'user', text: question }, { role: 'assistant', text: result.text }], this.s.thread))
      }
    } finally {
      await this.react(m, false)
    }
  }

  private async answerMessage(m: Message, threadId: string | undefined): Promise<void> {
    const question = this.stripMention(m.content)
    await this.sendAnswer(m, threadId, question)
  }

  /** Removes "@mnemo" from the question; the model does not need it. */
  private stripMention(content: string): string {
    // The mention picker writes the handle (`@bot-…`); people also type the
    // display name by hand. READY carries both.
    let s = content
    for (const name of [this.selfHandle, this.selfName]) {
      if (!name) continue
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      s = s.replace(new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,:;!?])`, 'gi'), ' ')
    }
    return s.replace(/\s+/g, ' ').trim()
  }

  private async react(m: Message, on: boolean): Promise<void> {
    try {
      if (on) await this.client.rest.addReaction(m.channel_id, m.id, THINKING)
      else await this.client.rest.removeReaction(m.channel_id, m.id, THINKING)
    } catch {
      // Reacting is a courtesy; without the permission Mnemo still answers.
    }
  }

  private async post(
    channelId: string,
    text: string,
    components: ReturnType<MnemoBot['buttons']> | undefined,
    where: { parent_id: string } | { message_reference: { message_id: string } },
  ): Promise<void> {
    const parts = splitMessage(text)
    for (const [n, content] of parts.entries()) {
      const last = n === parts.length - 1
      await this.client.rest.createMessage(channelId, {
        content,
        ...(n === 0 || 'parent_id' in where ? where : {}),
        ...(last && components ? { components } : {}),
        allowed_mentions: NO_PINGS,
      })
    }
  }

  // ---- /ask and the buttons ------------------------------------------------

  private async onInteraction(i: Interaction): Promise<void> {
    if (i.isCommand() && i.commandName === 'ask') return this.onAsk(i)
    if (i.isCommand() && i.commandName === 'details') return this.onDetails(i)
    const id = i.isButton() || i.isModalSubmit() ? parseCustomId(i.customId) : undefined
    if (!id) return
    if (id.kind === 'consent_yes' || id.kind === 'consent_no') {
      return this.onConsent(i, id.kind, id.answerId)
    }
    if (i.isModalSubmit() && id.kind === 'followup') return this.onFollowUpSubmit(i, id.answerId)
    const rec = this.answers.get(id.answerId)
    if (!rec) {
      await i.reply({ content: 'This answer is too old for that now. Ask me again.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    if (id.kind === 'regen') {
      await this.onRegenerate(i, id.answerId, rec)
    } else if (id.kind === 'follow') {
      await i.showModal(
        modal({
          customId: customId('followup', id.answerId),
          title: 'Ask Mnemo a follow-up',
          components: [
            actionRow(
              textInput({ customId: 'question', label: 'Your question', style: TextInputStyle.Paragraph, maxLength: 1000, required: true }),
            ),
          ],
        }),
      )
    }
  }

  private isAdmin(i: Interaction): boolean {
    return this.s.adminUserIds.includes(i.user.id) || i.hasPermission(Permissions.Administrator)
  }

  /** /details: admins only. Everyone else gets a private refusal, and no
   * detail reaches the channel or anyone else. */
  private async onDetails(i: Interaction): Promise<void> {
    // Admins only: server administrators or configured adminUserIds.
    if (!this.isAdmin(i)) {
      this.log.info('details_refused', { user: i.user.id, channel: i.channelId })
      await i.reply({ content: 'Only Mnemo admins can see how an answer was made.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    const answerId = this.lastAnswer.get(i.channelId)
    const rec = answerId ? this.answers.get(answerId) : undefined
    if (!rec) {
      await i.reply({ content: 'I have no recent public answer in this channel to show details for.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    this.log.info('details_viewed', { user: i.user.id, channel: i.channelId, answer: answerId })
    await i.reply({ content: detailsText(rec.details), ephemeral: true, allowed_mentions: NO_PINGS })
  }

  private async onAsk(i: Interaction): Promise<void> {
    const ephemeral = i.options.get('private') === true
    if (!this.allowed(i.channelId)) {
      await i.reply({ content: 'I do not answer in this channel. Ask me in one where I am enabled.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    const question = String(i.options.get('question') ?? '')
    if (await this.refusedPrivately(i)) return
    await i.deferReply({ ephemeral })
    await this.answerInteraction(i, { question, history: [], ephemeral, first: 'edit', regenerations: 0 })
  }

  private async onFollowUpSubmit(i: Interaction, answerId: string): Promise<void> {
    const rec = this.answers.get(answerId)
    const question = i.fields.get('question') ?? ''
    const ephemeral = rec?.ephemeral ?? false
    if (await this.refusedPrivately(i)) return
    await i.deferReply({ ephemeral })
    const history = rec ? boundHistory([...rec.history, { role: 'user', text: rec.question }, { role: 'assistant', text: rec.answer }], this.s.thread) : []
    await this.answerInteraction(i, { question, history, ephemeral, first: 'edit', regenerations: 0 })
  }

  private async onRegenerate(i: Interaction, answerId: string, rec: AnswerRecord): Promise<void> {
    if (i.user.id !== rec.askerId && !this.isAdmin(i)) {
      await i.reply({ content: 'Only the person who asked, or a Mnemo admin, can regenerate this answer.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    // The button is hidden at the limit, but a custom id can be forged.
    if (rec.regenerations >= this.s.maxRegenerations) {
      await i.reply({ content: 'This answer was regenerated as often as allowed. Ask a new question or a follow-up.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    if (await this.refusedPrivately(i)) return
    // Claimed with no await between check and delete, so a double click
    // regenerates once.
    if (!this.answers.has(answerId)) {
      await i.reply({ content: 'This answer is too old for that now. Ask me again.', ephemeral: true, allowed_mentions: NO_PINGS })
      return
    }
    this.answers.delete(answerId)
    await i.deferUpdate()
    // The old answer stays readable; its buttons go, the new answer gets them.
    await i.editReply({ components: [] }).catch(() => undefined)
    if (rec.threadId) {
      const threadId = rec.threadId
      await this.serial(threadId, async () => {
        const result = await this.engine.ask({
          question: rec.question,
          history: rec.history,
          userId: i.user.id,
          channelId: rec.channelId,
          askerName: i.user.display_name,
          admitted: true,
        })
        const newId = this.remember(result, { ...rec, ephemeral: false, regenerations: rec.regenerations + 1 })
        await this.post(rec.channelId, result.text, newId ? this.buttons(newId, false, rec.regenerations + 1) : undefined, { parent_id: threadId })
        if (result.kind === 'answer') this.replaceInThread(threadId, rec.answer, result.text)
      })
      return
    }
    await this.answerInteraction(i, { question: rec.question, history: rec.history, ephemeral: rec.ephemeral, first: 'followup', regenerations: rec.regenerations + 1, askerId: rec.askerId })
  }

  /** Checks the limits for an interaction; a refusal goes only to the member. */
  private async refusedPrivately(i: Interaction): Promise<boolean> {
    const refused = this.engine.admit(i.user.id, i.channelId)
    if (!refused) return false
    await i.reply({ content: refused.text, ephemeral: true, allowed_mentions: NO_PINGS })
    return true
  }

  /** Answers through the interaction: the first part as the reply (or a
   * follow-up), the rest as follow-ups, the buttons under the last part. */
  private async answerInteraction(
    i: Interaction,
    q: { question: string; history: HistoryTurn[]; ephemeral: boolean; first: 'edit' | 'followup'; regenerations: number; askerId?: string },
  ): Promise<void> {
    const result = await this.engine.ask({
      question: q.question,
      history: q.history,
      userId: i.user.id,
      channelId: i.channelId,
      askerName: i.user.display_name || i.user.username,
      admitted: true,
    })
    const answerId = this.remember(result, { question: q.question, history: q.history, askerId: q.askerId ?? i.user.id, channelId: i.channelId, ephemeral: q.ephemeral, regenerations: q.regenerations })
    const parts = splitMessage(result.text)
    for (const [n, content] of parts.entries()) {
      const last = n === parts.length - 1
      const components = last && answerId ? this.buttons(answerId, true, q.regenerations) : undefined
      const data = { content, allowed_mentions: NO_PINGS, ...(components ? { components } : {}) }
      // The first part replaces the deferred reply, which already knows
      // whether it is private; follow-ups say it themselves.
      if (n === 0 && q.first === 'edit') await i.editReply(data)
      else await i.followUp({ ...data, ephemeral: q.ephemeral })
    }
  }

  /** Regenerate (until its limit), and Follow up under interaction answers;
   * no buttons at all when neither applies. Details are not a button: they
   * are for admins, through /details. */
  private buttons(answerId: string, followUp: boolean, regenerations: number) {
    const row = []
    if (regenerations < this.s.maxRegenerations) {
      row.push(button({ customId: customId('regen', answerId), label: 'Regenerate', style: ButtonStyle.Secondary }))
    }
    if (followUp) row.push(button({ customId: customId('follow', answerId), label: 'Follow up', style: ButtonStyle.Primary }))
    return row.length > 0 ? [actionRow(...row)] : undefined
  }

  /** Keeps what the buttons need; refusals (limits, budget) get no buttons. */
  private remember(result: AskResult, r: Omit<AnswerRecord, 'answer' | 'details'>): string | undefined {
    if (result.kind !== 'answer') return undefined
    const id = randomBytes(9).toString('base64url')
    const context = r.history.length === 0 ? 'none' : r.threadId ? 'thread' : 'follow-up'
    const details = detailsFrom(result, r.history.length, context, this.s.sendDisplayName, this.budget.costUsd(result.usage))
    this.answers.set(id, { ...r, answer: result.text, details })
    if (!r.ephemeral) this.lastAnswer.set(r.channelId, id)
    this.log.info('answer_details', {
      answer: id,
      channel: r.channelId,
      ...(r.ephemeral ? {} : { asker: r.askerId }),
      provider: details.provider,
      model: details.model,
      tools: details.toolsUsed.map((t) => `${t.name}${t.ok ? '' : ':failed'}`),
      input_tokens: details.inputTokens,
      output_tokens: details.outputTokens,
      cost_usd: details.costUsd,
      context: details.context,
      history_turns: details.historyTurns,
      regenerations: r.regenerations,
    })
    return id
  }

  private replaceInThread(threadId: string, oldText: string, newText: string): void {
    const turns = this.threads.get(threadId)
    if (!turns) return
    const at = turns.findLastIndex((t) => t.role === 'assistant' && t.text === oldText)
    if (at >= 0) this.threads.set(threadId, turns.map((t, n) => (n === at ? { role: 'assistant', text: newText } : t)))
  }

  private async serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(key, tail)
    try {
      await next
    } catch (err) {
      // Status, code and route only: a server message can quote the message.
      if (err instanceof RestError) this.log.warn('mnema_api_error', { status: err.status, code: err.code, method: err.method, path: err.path })
      else throw err
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }

  /** For the health endpoint. */
  stats(): Record<string, number> {
    return { threads: this.threads.size, answers: this.answers.size, consents: this.consents.size }
  }
}
