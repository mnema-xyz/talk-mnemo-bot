// The answers Mnemo gave recently: what their buttons and /details need,
// and which buttons an answer gets.
import { randomBytes } from 'node:crypto'
import { actionRow, button, ButtonStyle, type ButtonComponent } from '@mnema-xyz/bot-sdk'
import type { AskResult } from '../engine/engine.ts'
import type { Budget } from '../engine/limits.ts'
import { LruMap, type HistoryTurn } from '../engine/memory.ts'
import type { Logger } from '../log.ts'
import type { Buttons } from './chat.ts'
import { customId, detailsFrom, type AnswerDetails } from './delivery.ts'

/** What a button needs to know about the answer it sits under. */
export interface AnswerRecord {
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

const MAX_ANSWERS = 2000
const DAY_MS = 24 * 3600_000

export class AnswerStore {
  private readonly answers = new LruMap<AnswerRecord>(MAX_ANSWERS, DAY_MS)
  /** The last public answer per channel, for /details. */
  private readonly lastAnswer = new LruMap<string>(MAX_ANSWERS, DAY_MS)
  private readonly budget: Budget
  private readonly s: { maxRegenerations: number; sendDisplayName: boolean }
  private readonly log: Logger

  constructor(budget: Budget, settings: { maxRegenerations: number; sendDisplayName: boolean }, log: Logger) {
    this.budget = budget
    this.s = settings
    this.log = log
  }

  get(id: string): AnswerRecord | undefined {
    return this.answers.get(id)
  }

  has(id: string): boolean {
    return this.answers.has(id)
  }

  delete(id: string): void {
    this.answers.delete(id)
  }

  get size(): number {
    return this.answers.size
  }

  /** The last public answer in a channel, with its id. */
  lastIn(channelId: string): { id: string; rec: AnswerRecord } | undefined {
    const id = this.lastAnswer.get(channelId)
    const rec = id ? this.answers.get(id) : undefined
    return id && rec ? { id, rec } : undefined
  }

  /** Regenerate (until its limit), and Follow up under interaction answers;
   * no buttons at all when neither applies. Details are not a button: they
   * are for admins, through /details. */
  buttons(answerId: string, followUp: boolean, regenerations: number): Buttons | undefined {
    const row: ButtonComponent[] = []
    if (regenerations < this.s.maxRegenerations) {
      row.push(button({ customId: customId('regen', answerId), label: 'Regenerate', style: ButtonStyle.Secondary }))
    }
    if (followUp) row.push(button({ customId: customId('follow', answerId), label: 'Follow up', style: ButtonStyle.Primary }))
    return row.length > 0 ? [actionRow(...row)] : undefined
  }

  /** Keeps what the buttons need; refusals (limits, budget) get no buttons. */
  remember(result: AskResult, r: Omit<AnswerRecord, 'answer' | 'details'>): string | undefined {
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
}
