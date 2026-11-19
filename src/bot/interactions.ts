// /ask, /details and the buttons under an answer (Regenerate, Follow up).
// The consent buttons are handed back to the bot, which owns the attachment
// path.
import { actionRow, modal, Permissions, textInput, TextInputStyle, type Client, type Interaction } from '@mnema-xyz/bot-sdk'
import type { Engine } from '../engine/engine.ts'
import { boundHistory, type HistoryTurn, type LruMap } from '../engine/memory.ts'
import { splitMessage } from '../engine/split.ts'
import type { Logger } from '../log.ts'
import type { AnswerRecord, AnswerStore } from './answers.ts'
import { NO_PINGS, post } from './chat.ts'
import { customId, detailsText, parseCustomId } from './delivery.ts'
import type { BotSettings } from './settings.ts'

/** What the interaction handlers share with the bot. */
export interface BotCore {
  client: Client
  engine: Engine
  s: BotSettings
  log: Logger
  answers: AnswerStore
  threads: LruMap<HistoryTurn[]>
  /** Runs fn after the thread's earlier answers. */
  serial(key: string, fn: () => Promise<void>): Promise<void>
  allowed(channelId: string): boolean
  onConsent(i: Interaction, kind: 'consent_yes' | 'consent_no', consentId: string): Promise<void>
}

interface InteractionQuestion {
  question: string
  history: HistoryTurn[]
  ephemeral: boolean
  first: 'edit' | 'followup'
  regenerations: number
  askerId?: string
}

const TOO_OLD = 'This answer is too old for that now. Ask me again.'

export class Interactions {
  private readonly c: BotCore

  constructor(core: BotCore) {
    this.c = core
  }

  async handle(i: Interaction): Promise<void> {
    if (i.isCommand() && i.commandName === 'ask') return this.onAsk(i)
    if (i.isCommand() && i.commandName === 'details') return this.onDetails(i)
    const id = i.isButton() || i.isModalSubmit() ? parseCustomId(i.customId) : undefined
    if (!id) return
    if (id.kind === 'consent_yes' || id.kind === 'consent_no') return this.c.onConsent(i, id.kind, id.answerId)
    if (i.isModalSubmit() && id.kind === 'followup') return this.onFollowUpSubmit(i, id.answerId)
    const rec = this.c.answers.get(id.answerId)
    if (!rec) return this.privately(i, TOO_OLD)
    if (id.kind === 'regen') await this.onRegenerate(i, id.answerId, rec)
    else if (id.kind === 'follow') await this.showFollowUp(i, id.answerId)
  }

  private privately(i: Interaction, content: string): Promise<void> {
    return i.reply({ content, ephemeral: true, allowed_mentions: NO_PINGS })
  }

  private showFollowUp(i: Interaction, answerId: string): Promise<void> {
    return i.showModal(
      modal({
        customId: customId('followup', answerId),
        title: 'Ask Mnemo a follow-up',
        components: [
          actionRow(textInput({ customId: 'question', label: 'Your question', style: TextInputStyle.Paragraph, maxLength: 1000, required: true })),
        ],
      }),
    )
  }

  private isAdmin(i: Interaction): boolean {
    return this.c.s.adminUserIds.includes(i.user.id) || i.hasPermission(Permissions.Administrator)
  }

  /** /details: admins only (server administrators or configured adminUserIds).
   * Everyone else gets a private refusal, and no detail reaches the channel
   * or anyone else. */
  private async onDetails(i: Interaction): Promise<void> {
    if (!this.isAdmin(i)) {
      this.c.log.info('details_refused', { user: i.user.id, channel: i.channelId })
      return this.privately(i, 'Only Mnemo admins can see how an answer was made.')
    }
    const last = this.c.answers.lastIn(i.channelId)
    if (!last) return this.privately(i, 'I have no recent public answer in this channel to show details for.')
    this.c.log.info('details_viewed', { user: i.user.id, channel: i.channelId, answer: last.id })
    await this.privately(i, detailsText(last.rec.details))
  }

  private async onAsk(i: Interaction): Promise<void> {
    const ephemeral = i.options.get('private') === true
    if (!this.c.allowed(i.channelId)) return this.privately(i, 'I do not answer in this channel. Ask me in one where I am enabled.')
    const question = String(i.options.get('question') ?? '')
    if (await this.refusedPrivately(i)) return
    await i.deferReply({ ephemeral })
    await this.answer(i, { question, history: [], ephemeral, first: 'edit', regenerations: 0 })
  }

  private async onFollowUpSubmit(i: Interaction, answerId: string): Promise<void> {
    const rec = this.c.answers.get(answerId)
    const question = i.fields.get('question') ?? ''
    const ephemeral = rec?.ephemeral ?? false
    if (await this.refusedPrivately(i)) return
    await i.deferReply({ ephemeral })
    const history = rec ? boundHistory([...rec.history, { role: 'user', text: rec.question }, { role: 'assistant', text: rec.answer }], this.c.s.thread) : []
    await this.answer(i, { question, history, ephemeral, first: 'edit', regenerations: 0 })
  }

  private async onRegenerate(i: Interaction, answerId: string, rec: AnswerRecord): Promise<void> {
    if (i.user.id !== rec.askerId && !this.isAdmin(i)) {
      return this.privately(i, 'Only the person who asked, or a Mnemo admin, can regenerate this answer.')
    }
    // The button is hidden at the limit, but a custom id can be forged.
    if (rec.regenerations >= this.c.s.maxRegenerations) {
      return this.privately(i, 'This answer was regenerated as often as allowed. Ask a new question or a follow-up.')
    }
    if (await this.refusedPrivately(i)) return
    // Claimed with no await between check and delete, so a double click
    // regenerates once.
    if (!this.c.answers.has(answerId)) return this.privately(i, TOO_OLD)
    this.c.answers.delete(answerId)
    await i.deferUpdate()
    // The old answer stays readable; its buttons go, the new answer gets them.
    await i.editReply({ components: [] }).catch(() => undefined)
    if (rec.threadId) return this.regenerateInThread(i, rec, rec.threadId)
    await this.answer(i, { question: rec.question, history: rec.history, ephemeral: rec.ephemeral, first: 'followup', regenerations: rec.regenerations + 1, askerId: rec.askerId })
  }

  /** A thread answer is regenerated into the thread, and the thread's memory
   * keeps the new answer instead of the old one. */
  private regenerateInThread(i: Interaction, rec: AnswerRecord, threadId: string): Promise<void> {
    return this.c.serial(threadId, async () => {
      const result = await this.c.engine.ask({
        question: rec.question,
        history: rec.history,
        userId: i.user.id,
        channelId: rec.channelId,
        askerName: i.user.display_name,
        admitted: true,
      })
      const regenerations = rec.regenerations + 1
      const newId = this.c.answers.remember(result, { ...rec, ephemeral: false, regenerations })
      await post(this.c.client, rec.channelId, result.text, newId ? this.c.answers.buttons(newId, false, regenerations) : undefined, { parent_id: threadId })
      if (result.kind === 'answer') this.replaceInThread(threadId, rec.answer, result.text)
    })
  }

  private replaceInThread(threadId: string, oldText: string, newText: string): void {
    const turns = this.c.threads.get(threadId)
    if (!turns) return
    const at = turns.findLastIndex((t) => t.role === 'assistant' && t.text === oldText)
    if (at >= 0) this.c.threads.set(threadId, turns.map((t, n) => (n === at ? { role: 'assistant', text: newText } : t)))
  }

  /** Checks the limits for an interaction; a refusal goes only to the member. */
  private async refusedPrivately(i: Interaction): Promise<boolean> {
    const refused = this.c.engine.admit(i.user.id, i.channelId)
    if (!refused) return false
    await this.privately(i, refused.text)
    return true
  }

  /** Answers through the interaction: the first part as the reply (or a
   * follow-up), the rest as follow-ups, the buttons under the last part. */
  private async answer(i: Interaction, q: InteractionQuestion): Promise<void> {
    const result = await this.c.engine.ask({
      question: q.question,
      history: q.history,
      userId: i.user.id,
      channelId: i.channelId,
      askerName: i.user.display_name || i.user.username,
      admitted: true,
    })
    const answerId = this.c.answers.remember(result, {
      question: q.question,
      history: q.history,
      askerId: q.askerId ?? i.user.id,
      channelId: i.channelId,
      ephemeral: q.ephemeral,
      regenerations: q.regenerations,
    })
    const parts = splitMessage(result.text)
    for (const [n, content] of parts.entries()) {
      const last = n === parts.length - 1
      const components = last && answerId ? this.c.answers.buttons(answerId, true, q.regenerations) : undefined
      const data = { content, allowed_mentions: NO_PINGS, ...(components ? { components } : {}) }
      // The first part replaces the deferred reply, which already knows
      // whether it is private; follow-ups say it themselves.
      if (n === 0 && q.first === 'edit') await i.editReply(data)
      else await i.followUp({ ...data, ephemeral: q.ephemeral })
    }
  }
}
