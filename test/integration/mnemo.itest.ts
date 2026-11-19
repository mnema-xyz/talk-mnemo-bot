// End-to-end against a real Mnema Talk (started by scripts/integration.sh):
// the Owner adds Mnemo from its manifest, Mnemo runs as `node src/main.ts`
// with the fake provider, and a member mentions it, talks in its thread,
// runs /ask and clicks its buttons.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

const URL_ = process.env.IT_URL ?? ''
const USER = process.env.IT_ADMIN_USER ?? ''
const PASSWORD = process.env.IT_ADMIN_PASSWORD ?? ''

/** A member session: the cookie jar and the Origin header the API wants. */
class Session {
  private cookies = new Map<string, string>()
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(URL_ + path, {
      method,
      headers: {
        Origin: URL_,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';')
      const at = pair.indexOf('=')
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const text = await res.text()
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
  }
  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body)
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} answered ${r.status}: ${JSON.stringify(r.json)}`)
    return r.json
  }
}

interface Msg {
  id: string
  user_id: string
  content: string
  parent_id?: string
  components?: { type: number; components: { custom_id?: string; label?: string }[] }[]
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => {
        resolve(port)
      })
    })
  })
}

const labels = (m: Msg): string[] => (m.components ?? []).flatMap((r) => r.components.map((c) => c.label ?? ''))
const buttonId = (m: Msg, label: string): string => {
  const id = (m.components ?? []).flatMap((r) => r.components).find((c) => c.label === label)?.custom_id
  assert.ok(id, `no ${label} button on ${JSON.stringify(m)}`)
  return id
}

const skip = !URL_ && 'run through scripts/integration.sh'

/** The running stack: the Owner's session, the channel, the bot and Mnemo's process. */
const w = {
  owner: new Session(),
  channelId: '',
  botUserId: '',
  botUsername: '',
  mnemo: undefined as ChildProcess | undefined,
  healthUrl: '',
  logs: [] as string[],
}

/** Logs the Owner in, adds Mnemo from its manifest and starts it with the fake provider. */
async function startMnemo(): Promise<void> {
  await w.owner.ok('POST', '/api/auth/login', { username: USER, password: PASSWORD })
  const ch = await w.owner.ok<{ id: string }>('POST', '/api/admin/channels', { name: 'mnemo-it', type: 'text' })
  w.channelId = ch.id

  const manifest = JSON.parse(readFileSync(new URL('../../mnemo.manifest.json', import.meta.url), 'utf8')) as {
    permissions: string[]
    intents: string[]
  }
  const installed = await w.owner.ok<{ bot: { user_id: string; username?: string }; token: { secret: string } }>('POST', '/api/admin/bots/install', {
    manifest,
    permissions: manifest.permissions,
    intents: manifest.intents,
    channel_ids: [w.channelId],
  })
  w.botUserId = installed.bot.user_id
  const members = await w.owner.ok<{ id: string; username: string }[]>('GET', '/api/members')
  w.botUsername = members.find((m) => m.id === w.botUserId)?.username ?? installed.bot.username ?? ''
  assert.ok(w.botUsername, 'the bot is listed as a member')

  const port = await freePort()
  w.healthUrl = `http://127.0.0.1:${port}/healthz`
  w.mnemo = spawn(process.execPath, ['src/main.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: {
      PATH: process.env.PATH,
      MNEMA_URL: URL_,
      MNEMA_TOKEN: installed.token.secret,
      MNEMO_PROVIDER: 'fake',
      MNEMO_HEALTH_PORT: String(port),
      MNEMO_LOG_LEVEL: 'debug',
      MNEMO_MEMBER_LIMIT_PER_MINUTE: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  w.mnemo.stdout?.on('data', (d: Buffer) => w.logs.push(d.toString()))
  w.mnemo.stderr?.on('data', (d: Buffer) => w.logs.push(d.toString()))
  await until('Mnemo to connect', async () => {
    const r = await fetch(w.healthUrl).catch(() => undefined)
    return r?.status === 200 ? true : undefined
  })
}

function stopMnemo(): void {
  if (w.mnemo && w.mnemo.exitCode === null) w.mnemo.kill('SIGKILL')
  // Mnemo's own log, for a failed run (git-ignored).
  writeFileSync(new URL('./mnemo.log', import.meta.url), w.logs.join(''))
}

const thread = async (rootId: string) => (await w.owner.ok<{ replies: Msg[] }>('GET', `/api/messages/${rootId}/thread`)).replies
const channelMessages = () => w.owner.ok<Msg[]>('GET', `/api/channels/${w.channelId}/messages?limit=50`)
const fromBot = (ms: Msg[]) => ms.filter((m) => m.user_id === w.botUserId)

before(async () => {
  if (!skip) await startMnemo()
})
after(() => {
  if (!skip) stopMnemo()
})

describe('Mnemo on a real Mnema Talk: mentions and threads', { skip }, () => {
  it('answers a mention in a new thread under the question, with buttons', async () => {
    const q = await w.owner.ok<Msg>('POST', `/api/channels/${w.channelId}/messages`, { content: `@${w.botUsername} what is 2+2?` })
    const reply = await until('the answer in the thread', async () => fromBot(await thread(q.id)).at(0))
    assert.equal(reply.content, 'You asked: what is 2+2?')
    assert.equal(reply.parent_id, q.id)
    assert.deepEqual(labels(reply), ['Regenerate'])

    // In its thread Mnemo answers without a mention and keeps the context.
    await w.owner.ok('POST', `/api/channels/${w.channelId}/messages`, { content: 'and 3+3?', parent_id: q.id })
    const second = await until('the second answer', async () => fromBot(await thread(q.id)).at(1))
    assert.equal(second.content, 'You asked: and 3+3? (with 2 earlier messages)')
  })

  it('answers a mention in somebody else\'s thread once, without following that thread', async () => {
    const root = await w.owner.ok<Msg>('POST', `/api/channels/${w.channelId}/messages`, { content: 'a thread of our own' })
    await w.owner.ok('POST', `/api/channels/${w.channelId}/messages`, { content: `@${w.botUsername} what is 5+5?`, parent_id: root.id })
    const reply = await until('the answer in that thread', async () => fromBot(await thread(root.id)).at(0))
    assert.equal(reply.content, 'You asked: what is 5+5?')
    await w.owner.ok('POST', `/api/channels/${w.channelId}/messages`, { content: 'thanks, carry on', parent_id: root.id })
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(fromBot(await thread(root.id)).length, 1)
  })

  it('ignores messages that do not mention it outside its threads', async () => {
    const q = await w.owner.ok<Msg>('POST', `/api/channels/${w.channelId}/messages`, { content: 'just chatting' })
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(fromBot(await thread(q.id)).length, 0)
  })
})

describe('Mnemo on a real Mnema Talk: /ask, limits and shutdown', { skip }, () => {
  it('answers /ask, and Regenerate replaces the buttons with a new answer', async () => {
    const commands = await w.owner.ok<{ id: string; name: string; bot_name?: string }[]>('GET', `/api/channels/${w.channelId}/commands`)
    const ask = commands.find((c) => c.name === 'ask' && c.bot_name)
    assert.ok(ask, 'the manifest registered /ask')
    const run = await w.owner.call('POST', `/api/channels/${w.channelId}/interactions`, { command_id: ask.id, options: { question: 'hello there' } })
    assert.equal(run.status, 202)
    const answer = await until('the /ask answer', async () => fromBot(await channelMessages()).find((m) => m.content === 'You asked: hello there'))
    assert.deepEqual(labels(answer), ['Regenerate', 'Follow up'])

    const regen = await w.owner.call('POST', `/api/channels/${w.channelId}/messages/${answer.id}/components`, { custom_id: buttonId(answer, 'Regenerate') })
    assert.equal(regen.status, 202)
    await until('the old buttons to go', async () => {
      const m = (await channelMessages()).find((x) => x.id === answer.id)
      return m && labels(m).length === 0 ? true : undefined
    })
    const again = await until('the regenerated answer', async () =>
      fromBot(await channelMessages()).find((m) => m.id !== answer.id && m.content === 'You asked: hello there'),
    )
    assert.deepEqual(labels(again), ['Regenerate', 'Follow up'])
  })

  it('tells a member who floods it about the limit once, and drops the rest quietly', async () => {
    const asked: Msg[] = []
    for (let n = 0; n < 10; n++) {
      asked.push(await w.owner.ok<Msg>('POST', `/api/channels/${w.channelId}/messages`, { content: `@${w.botUsername} flood ${n}` }))
    }
    const replies = async () => (await Promise.all(asked.map(async (q) => fromBot(await thread(q.id))))).flat()
    await until('the refusal', async () => ((await replies()).some((m) => /asking quickly/.test(m.content)) ? true : undefined))
    // Bot posts are limited to 5 per 5 s per channel, so late ones trickle in:
    // wait until nothing new arrived for 7 s.
    let all = await replies()
    for (let quiet = 0; quiet < 7; ) {
      await new Promise((r) => setTimeout(r, 1000))
      const now = await replies()
      quiet = now.length === all.length ? quiet + 1 : 0
      all = now
    }
    assert.equal(all.filter((m) => /asking quickly/.test(m.content)).length, 1, JSON.stringify(all.map((m) => m.content)))
    assert.ok(all.length < asked.length, 'some mentions got no post at all')
  })

  it('reports healthy and stops cleanly on SIGTERM', async () => {
    const health = (await (await fetch(w.healthUrl)).json()) as { status: string; provider: string }
    assert.equal(health.status, 'ok')
    assert.equal(health.provider, 'fake')
    const exited = new Promise<number | null>((resolve) => {
      w.mnemo?.once('exit', (code) => {
        resolve(code)
      })
    })
    w.mnemo?.kill('SIGTERM')
    assert.equal(await exited, 0)
  })
})
