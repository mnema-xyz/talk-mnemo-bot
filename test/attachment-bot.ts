// The attachment path of MnemoBot with a fake client: what it posts, edits and
// downloads. Shared by the attachment and consent tests.
import { EventEmitter } from 'node:events'
import { NotFoundError, type Client, type Interaction } from '@mnema-xyz/bot-sdk'
import { MnemoBot, type BotSettings } from '../src/bot/bot.ts'
import { Engine } from '../src/engine/engine.ts'
import { Budget, RateLimiter } from '../src/engine/limits.ts'
import { silentLogger } from '../src/log.ts'
import { fakeProvider } from '../src/providers/fake.ts'
import { BUILTIN_TOOLS } from '../src/tools/index.ts'

export interface Sent {
  content?: string
  ephemeral?: boolean
  components?: { components: { custom_id?: string; customId?: string; label?: string }[] }[]
}

export const SETTINGS: BotSettings = {
  allowedChannels: [],
  adminUserIds: ['admin'],
  maxRegenerations: 2,
  replyInThread: false,
  sendDisplayName: false,
  thread: { maxTurns: 12, maxChars: 12000, ttlMs: 3600_000 },
  vision: true,
  attachments: {
    enabled: true,
    maxBytes: 10 * 1024 * 1024,
    askConsent: true,
  },
}

export function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

export function setupBot(
  overSettings: Partial<BotSettings> = {},
  clientMocks: {
    download?: (id: string) => Promise<{ contentType: string; size: number; filename: string; stream: ReadableStream<Uint8Array> }>
    getMessage?: (channelId: string, messageId: string) => Promise<unknown>
  } = {},
  fakeSteps: Parameters<typeof fakeProvider>[0] = [],
  limits: { member?: number; channel?: number; budget?: Budget } = {},
) {
  const events = new EventEmitter()
  const posted: Sent[] = []
  const downloadCalls: string[] = []
  const edits: { channelId: string; messageId: string; data: Sent }[] = []
  const provider = fakeProvider(fakeSteps)

  const client = Object.assign(events, {
    commands: { set: () => Promise.resolve() },
    setPresence: () => undefined,
    rest: {
      addReaction: () => Promise.resolve(),
      removeReaction: () => Promise.resolve(),
      createMessage: (_c: string, body: Sent) => {
        posted.push(body)
        const id = `msg_${posted.length}`
        return Promise.resolve({ id, channel_id: _c, ...body })
      },
      editMessage: (channelId: string, messageId: string, data: Sent) => {
        edits.push({ channelId, messageId, data })
        return Promise.resolve()
      },
      getMessage: (channelId: string, messageId: string) => {
        if (clientMocks.getMessage) return clientMocks.getMessage(channelId, messageId)
        return Promise.reject(new NotFoundError({ status: 404, method: 'GET', path: '/api/channels/c1/messages/m1', body: { message: 'not found' } }))
      },
      downloadAttachment: (id: string) => {
        downloadCalls.push(id)
        if (clientMocks.download) return clientMocks.download(id)
        const sample = Buffer.from('sample text content')
        return Promise.resolve({
          contentType: 'text/plain',
          size: sample.length,
          filename: 'sample.txt',
          stream: makeStream([sample]),
        })
      },
    },
  }) as unknown as Client

  const engine = new Engine({
    provider,
    tools: BUILTIN_TOOLS,
    settings: {
      persona: 'You are Mnemo.',
      maxToolCalls: 3,
      maxOutputTokens: 1024,
      providerTimeoutMs: 5000,
      toolTimeoutMs: 5000,
      sendDisplayName: false,
      userAgent: 'Mnemo-test',
    },
    memberLimit: new RateLimiter(limits.member ?? 100, 60_000),
    channelLimit: new RateLimiter(limits.channel ?? 100, 60_000),
    budget: limits.budget ?? new Budget({ dailyTokens: 0, dailyCostUsd: 0, inputUsdPerMTok: 0, outputUsdPerMTok: 0 }),
    log: silentLogger,
  })

  new MnemoBot(client, engine, engine['d'].budget, { ...SETTINGS, ...overSettings }, silentLogger)
  events.emit('ready', { user: { id: 'bot_id', username: 'mnemo', handle: 'mnemo' }, session_id: 's' })

  const run = (i: object) => {
    events.emit('interactionCreate', i)
    return new Promise<void>((resolve) => setTimeout(resolve, 30))
  }
  const emitMessage = (m: object) => {
    events.emit('messageCreate', m)
    return new Promise<void>((resolve) => setTimeout(resolve, 50))
  }

  return { events, posted, edits, downloadCalls, provider, run, emitMessage }
}

export function fakeBtn(customId: string, userId = 'u1', channelId = 'c1') {
  const sent: Sent[] = []
  const i = {
    user: { id: userId, username: userId, display_name: userId },
    channelId,
    commandName: '',
    customId,
    options: new Map(),
    fields: new Map(),
    isCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    reply: (d: Sent) => Promise.resolve(void sent.push(d)),
    deferReply: () => Promise.resolve(),
    deferUpdate: () => Promise.resolve(),
    editReply: (d: Sent) => Promise.resolve(void sent.push(d)),
    followUp: (d: Sent) => Promise.resolve(void sent.push(d)),
  }
  return { i: i as unknown as Interaction, sent }
}

export const textOf = (s: Sent | undefined) => s?.content ?? ''
export const promptButtons = (s: Sent | undefined) => s?.components?.[0]?.components ?? []
export const isPrompt = (s: Sent) => promptButtons(s).length === 2
export const yesOf = (s: Sent | undefined) => promptButtons(s)[0]?.custom_id ?? ''

/** An attachment mention of a small text file, as `user` in `channel`. */
export function fileMention(n: number, user = 'u1', channel = 'c1', size = 20) {
  return {
    id: `m${n}`,
    channel_id: channel,
    user_id: user,
    username: user,
    mentions: ['bot_id'],
    content: '<@bot_id> read this',
    attachments: [{ id: `att${n}`, filename: 'file.txt', mime_type: 'text/plain', size_bytes: size }],
  }
}
