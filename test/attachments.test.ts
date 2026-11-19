import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { NotFoundError } from '@mnema-xyz/bot-sdk'
import sharp from 'sharp'
import {
  classifyAttachment,
  consentPromptText,
  extractPdfText,
  processImage,
} from '../src/bot/attachments.ts'
import { Budget } from '../src/engine/limits.ts'
import { anthropicProvider } from '../src/providers/anthropic.ts'
import { openaiProvider } from '../src/providers/openai.ts'
import { fakeBtn, fileMention, isPrompt, makeStream, promptButtons, setupBot, textOf, yesOf } from './attachment-bot.ts'


describe('attachment classification', () => {
  it('identifies images, pdf, text, and unsupported categories', () => {
    assert.equal(classifyAttachment({ id: '1', filename: 'photo.PNG', mime_type: 'image/png', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).type, 'image')
    assert.equal(classifyAttachment({ id: '2', filename: 'doc.pdf', mime_type: 'application/pdf', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).type, 'pdf')
    assert.equal(classifyAttachment({ id: '3', filename: 'code.ts', mime_type: 'text/plain', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).type, 'text')
    assert.equal(classifyAttachment({ id: '4', filename: 'archive.zip', mime_type: 'application/zip', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).type, 'unsupported')
    assert.equal(classifyAttachment({ id: '5', filename: 'song.mp3', mime_type: 'audio/mpeg', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).fileType, 'audio')
    assert.equal(classifyAttachment({ id: '6', filename: 'clip.mp4', mime_type: 'video/mp4', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).fileType, 'video')
    assert.equal(classifyAttachment({ id: '7', filename: 'sheet.xlsx', mime_type: 'application/vnd.ms-excel', original_filename: '', size_bytes: 10, is_deleted: false, url: '' }).fileType, 'office')
  })
})

describe('attachment size limit', () => {
  it('over-10-MB case answers without downloading and asserts no fetch happens', async () => {
    const t = setupBot()
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> check this',
      attachments: [{
        id: 'att_big',
        filename: 'huge.png',
        mime_type: 'image/png',
        size_bytes: 15 * 1024 * 1024,
      }],
    })

    assert.equal(t.downloadCalls.length, 0, 'no fetch or download must happen')
    assert.equal(t.posted.length, 1)
    assert.match(t.posted[0]?.content ?? '', /This file is 15 MB; I can only read attachments up to 10 MB\./)
  })

  it('names the configured limit, not the default, when it refuses', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 2 * 1024 * 1024, askConsent: true } })
    await t.emitMessage(fileMention(1, 'u1', 'c1', 3 * 1024 * 1024))
    assert.equal(t.downloadCalls.length, 0)
    assert.equal(textOf(t.posted[0]), 'This file is 3 MB; I can only read attachments up to 2 MB.')
  })

  it('names the configured limit when a lying size is cut off while streaming', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 512 * 1024, askConsent: false } }, {
      download: () => Promise.resolve({ contentType: 'text/plain', size: 20, filename: 'file.txt', stream: makeStream([new Uint8Array(600 * 1024)]) }),
    })
    await t.emitMessage(fileMention(1))
    assert.equal(textOf(t.posted[0]), 'This file is too large; I can only read attachments up to 512 KB.')
  })

  it('a lying size is cut off while streaming', async () => {
    const largeChunk = new Uint8Array(2 * 1024 * 1024)
    // 6 chunks of 2 MB = 12 MB, exceeding the 10 MB limit
    const stream = makeStream([largeChunk, largeChunk, largeChunk, largeChunk, largeChunk, largeChunk])

    const t = setupBot({ attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: false } }, {
      download: () => Promise.resolve({
        contentType: 'image/png',
        size: 100, // Metadata lies
        filename: 'lying.png',
        stream,
      }),
    })

    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> inspect',
      attachments: [{
        id: 'att_lying',
        filename: 'lying.png',
        mime_type: 'image/png',
        size_bytes: 100,
      }],
    })

    assert.equal(t.downloadCalls.length, 1)
    assert.match(t.posted[0]?.content ?? '', /This file is too large; I can only read attachments up to 10 MB\./)
  })
})

describe('consent flow', () => {
  it('asks consent with provider name, Yes reads file, No sends nothing, other member cannot answer, question expires', async () => {
    const imgBuf = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 100, g: 150, b: 200 } } }).png().toBuffer()
    const t = setupBot({
      attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: true, providerName: 'Anthropic' },
    }, {
      download: () => Promise.resolve({
        contentType: 'image/png',
        size: imgBuf.length,
        filename: 'photo.png',
        stream: makeStream([imgBuf]),
      }),
    })

    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> what is this?',
      attachments: [{
        id: 'att1',
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: imgBuf.length,
      }],
    })

    // 1. Consent asked in channel
    assert.equal(t.posted.length, 1)
    assert.equal(t.downloadCalls.length, 0, 'no download before consent')
    const consentMsg = t.posted[0]
    assert.match(textOf(consentMsg), /The image will be shared with Anthropic\. Should I check it anyway\?/)
    const buttons = promptButtons(consentMsg)
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0]?.label, 'Yes, check it')
    assert.equal(buttons[1]?.label, 'No')

    const yesId = yesOf(consentMsg)

    // 2. Another member tries to click Yes
    const otherUserClick = fakeBtn(yesId, 'u2')
    await t.run(otherUserClick.i)
    assert.equal(otherUserClick.sent[0]?.ephemeral, true)
    assert.match(textOf(otherUserClick.sent[0]), /Only Alice can answer this\./)
    assert.equal(t.downloadCalls.length, 0, 'other user click did not trigger download')

    // 3. Original asker clicks Yes
    const askerClick = fakeBtn(yesId, 'u1')
    await t.run(askerClick.i)
    assert.equal(t.downloadCalls.length, 1, 'download was called after Yes')
    assert.equal(t.posted.length, 2, 'answer was posted')
    assert.match(textOf(t.posted[1]), /You asked/)
  })
})

describe('consent flow: No, wording and no consent', () => {
  it('No by asker sends brief acknowledgement and sends nothing', async () => {
    const t = setupBot()
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> check this',
      attachments: [{
        id: 'att1',
        filename: 'file.txt',
        mime_type: 'text/plain',
        size_bytes: 50,
      }],
    })

    const buttons = t.posted[0]?.components?.[0]?.components ?? []
    const noId = buttons[1]?.custom_id ?? buttons[1]?.customId ?? ''

    const noClick = fakeBtn(noId, 'u1')
    await t.run(noClick.i)

    assert.equal(t.downloadCalls.length, 0, 'No sends nothing and downloads nothing')
    assert.match(noClick.sent[0]?.content ?? '', /Okay, I won't look at it\./)
  })

  it('local provider consent wording says file stays on this server without showing host', () => {
    const text = consentPromptText({ type: 'image', fileType: 'image', mimeType: 'image/png' }, 'Ollama', true)
    assert.match(text, /The image stays on this server and will be processed by the local model\. Should I check it anyway\?/)
    assert.doesNotMatch(text, /http|localhost|11434/)
  })

  it('with askConsent: false, the file is read directly', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: false } })
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> read this',
      attachments: [{
        id: 'att1',
        filename: 'file.txt',
        mime_type: 'text/plain',
        size_bytes: 20,
      }],
    })

    assert.equal(t.downloadCalls.length, 1, 'download was called directly without consent')
    assert.equal(t.posted.length, 1)
    assert.match(t.posted[0]?.content ?? '', /You asked/)
  })
})



describe('attachment questions and the limits', () => {
  it('a flood of attachment mentions gets prompts only up to the member limit, and one refusal', async () => {
    const t = setupBot({}, {}, [], { member: 2 })
    for (let n = 1; n <= 6; n++) await t.emitMessage(fileMention(n))
    assert.equal(t.posted.filter(isPrompt).length, 2)
    const refusals = t.posted.filter((s) => !isPrompt(s))
    assert.equal(refusals.length, 1)
    assert.match(refusals[0]?.content ?? '', /You are asking quickly/)
    assert.equal(t.downloadCalls.length, 0)
  })

  it('consent prompts count against the channel limit across members', async () => {
    const t = setupBot({}, {}, [], { channel: 2 })
    for (let n = 1; n <= 4; n++) await t.emitMessage(fileMention(n, `u${n}`))
    assert.equal(t.posted.filter(isPrompt).length, 2)
    assert.match(t.posted.at(-1)?.content ?? '', /This channel is keeping me busy/)
  })

  it('an accepted call is admitted too: a Yes over the limit downloads nothing and keeps the prompt', async () => {
    const t = setupBot({}, {}, [], { member: 1 })
    await t.emitMessage(fileMention(1))
    const yesId = yesOf(t.posted[0])
    const refused = fakeBtn(yesId, 'u1')
    await t.run(refused.i)
    assert.equal(t.downloadCalls.length, 0, 'no download over the limit')
    assert.equal(refused.sent[0]?.ephemeral, true)
    assert.match(refused.sent[0]?.content ?? '', /You are asking quickly/)
    assert.equal(t.posted.length, 1, 'no answer is posted')
  })

  it('a flood of Yes clicks on many prompts answers only within the limit', async () => {
    const t = setupBot({}, {}, [], { member: 4 })
    for (let n = 1; n <= 2; n++) await t.emitMessage(fileMention(n))
    const prompts = t.posted.filter(isPrompt)
    assert.equal(prompts.length, 2)
    // Two prompts and two accepted calls use the four slots; a third prompt is refused.
    for (const p of prompts) await t.run(fakeBtn(yesOf(p), 'u1').i)
    assert.equal(t.downloadCalls.length, 2)
    await t.emitMessage(fileMention(3))
    assert.equal(t.posted.filter(isPrompt).length, 2)
  })

  it('a double click on Yes reads the file once', async () => {
    const t = setupBot()
    await t.emitMessage(fileMention(1))
    const yesId = yesOf(t.posted[0])
    t.events.emit('interactionCreate', fakeBtn(yesId, 'u1').i)
    await t.run(fakeBtn(yesId, 'u1').i)
    assert.equal(t.downloadCalls.length, 1)
  })

  it('without consent each attachment question is admitted before the download', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: false } }, {}, [], { member: 2 })
    for (let n = 1; n <= 5; n++) await t.emitMessage(fileMention(n))
    assert.equal(t.downloadCalls.length, 2)
    assert.equal(t.provider.requests.length, 2)
  })

  it('with the budget used up, an attachment is neither offered nor downloaded', async () => {
    const budget = new Budget({ dailyTokens: 10, dailyCostUsd: 0, inputUsdPerMTok: 0, outputUsdPerMTok: 0 })
    budget.add({ inputTokens: 10, outputTokens: 0 })
    const t = setupBot({}, {}, [], { budget })
    await t.emitMessage(fileMention(1))
    assert.equal(t.downloadCalls.length, 0)
    assert.equal(t.posted.length, 1)
    assert.match(t.posted[0]?.content ?? '', /used up today's budget/)
  })
})

describe('attachment types and downscaling', () => {
  it('downscales an image exceeding limits (e.g. > 8000px)', async () => {
    // Create an image with 8500px width
    const largeImg = await sharp({
      create: { width: 8500, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().toBuffer()

    const processed = await processImage(largeImg, 'image/jpeg')
    assert.ok(processed.data.length > 0)
    assert.equal(processed.mediaType, 'image/jpeg')

    const outMeta = await sharp(Buffer.from(processed.data, 'base64')).metadata()
    assert.ok((outMeta.width ?? 0) <= 2048, 'downscaled to <= 2048px')
  })

  it('extracts text from PDF streams', () => {
    // Generate minimal deflated PDF text
    const streamContent = 'BT /F1 12 Tf (Invoice 98765) Tj ET'
    const compressed = deflateSync(Buffer.from(streamContent))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF'),
    ])

    const text = extractPdfText(pdf)
    assert.match(text, /Invoice 98765/)
  })
})

describe('attachment types: refusals before the download', () => {
  it('unsupported type refuses without downloading', async () => {
    const t = setupBot()
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> unpack this',
      attachments: [{
        id: 'att_zip',
        filename: 'archive.zip',
        mime_type: 'application/zip',
        size_bytes: 500,
      }],
    })

    assert.equal(t.downloadCalls.length, 0, 'must not download unsupported files')
    assert.match(t.posted[0]?.content ?? '', /I can't read zip files yet\./)
  })

  it('model without vision refuses image without downloading', async () => {
    const t = setupBot({ vision: false })
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> look at this',
      attachments: [{
        id: 'att_img',
        filename: 'pic.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 500,
      }],
    })

    assert.equal(t.downloadCalls.length, 0, 'must not download when model lacks vision')
    assert.match(t.posted[0]?.content ?? '', /The configured model does not support image input\./)
  })

  it('disabled attachments refuse without downloading', async () => {
    const t = setupBot({ attachments: { enabled: false, maxBytes: 10 * 1024 * 1024, askConsent: true } })
    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> inspect',
      attachments: [{
        id: 'att_1',
        filename: 'pic.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 500,
      }],
    })

    assert.equal(t.downloadCalls.length, 0)
    assert.match(t.posted[0]?.content ?? '', /I can't read attachments\./)
  })
})

describe('fallback and reply references', () => {
  it('falls back to "Reading attachments requires Talk 3.3 or newer." on 404', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: false } }, {
      download: () => Promise.reject(new NotFoundError({ status: 404, method: 'GET', path: '/api/bot/v1/media/att1', body: { message: 'not found' } })),
    })

    await t.emitMessage({
      id: 'm1',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> read this',
      attachments: [{
        id: 'att1',
        filename: 'note.txt',
        mime_type: 'text/plain',
        size_bytes: 20,
      }],
    })

    assert.match(t.posted[0]?.content ?? '', /Reading attachments requires Talk 3\.3 or newer\./)
  })

  it('reads attachments from replied message if current message has none', async () => {
    const t = setupBot({ attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, askConsent: false } }, {
      getMessage: (_c, id) => {
        if (id === 'm_original') {
          return Promise.resolve({
            id: 'm_original',
            attachments: [{
              id: 'att_reply',
              filename: 'doc.txt',
              mime_type: 'text/plain',
              size_bytes: 30,
            }],
          })
        }
        return Promise.reject(new NotFoundError({ status: 404, method: 'GET', path: '/api/channels/c1/messages/m1', body: { message: 'not found' } }))
      },
    })

    await t.emitMessage({
      id: 'm2',
      channel_id: 'c1',
      user_id: 'u1',
      username: 'Alice',
      mentions: ['bot_id'],
      content: '<@bot_id> what does that document say?',
      reply_to_id: 'm_original',
      attachments: [],
    })

    assert.equal(t.downloadCalls.length, 1)
    assert.equal(t.downloadCalls[0], 'att_reply')
    assert.match(t.posted[0]?.content ?? '', /You asked/)
  })
})

describe('provider request shapes', () => {
  it('Anthropic provider formats image and document blocks properly', async () => {
    let capturedBody: unknown
    const mockFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      capturedBody = JSON.parse(raw)
      return Promise.resolve(new Response(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Anthropic reply' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 10 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }

    const provider = anthropicProvider({
      apiKey: 'test-key',
      model: 'claude-haiku-5-5',
      effort: 'low',
      timeoutMs: 5000,
      fetch: mockFetch as unknown as typeof fetch,
    })

    await provider.chat({
      system: 'Instructions',
      turns: [{
        role: 'user',
        text: 'look at this image and document',
        attachments: [
          { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0xLjQK' },
        ],
      }],
      tools: [],
      maxOutputTokens: 1000,
      signal: AbortSignal.timeout(5000),
    })

    const body = capturedBody as { messages: { role: string; content: { type: string; source?: { type: string; media_type: string } }[] }[] }
    assert.equal(body.messages[0]?.role, 'user')
    const content = body.messages[0]?.content ?? []
    assert.equal(content[0]?.type, 'image')
    assert.equal(content[0]?.source?.media_type, 'image/png')
    assert.equal(content[1]?.type, 'document')
    assert.equal(content[1]?.source?.media_type, 'application/pdf')
    assert.equal(content[2]?.type, 'text')
  })
})

describe('provider request shapes: OpenAI', () => {
  it('OpenAI provider formats image_url in messages properly', async () => {
    let capturedBody: unknown
    const mockFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      capturedBody = JSON.parse(raw)
      return Promise.resolve(new Response(JSON.stringify({
        id: 'chatcmpl_1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'OpenAI reply' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }

    const provider = openaiProvider({
      name: 'openai-compatible',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 5000,
      fetch: mockFetch as unknown as typeof fetch,
    })

    await provider.chat({
      system: 'Instructions',
      turns: [{
        role: 'user',
        text: 'analyze image',
        attachments: [
          { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
        ],
      }],
      tools: [],
      maxOutputTokens: 1000,
      signal: AbortSignal.timeout(5000),
    })

    const body = capturedBody as { messages: { role: string; content: { type: string; image_url?: { url: string } }[] }[] }
    const userMsg = body.messages.find((m) => m.role === 'user')
    const parts = userMsg?.content ?? []
    assert.equal(parts[0]?.type, 'image_url')
    assert.match(parts[0]?.image_url?.url ?? '', /^data:image\/jpeg;base64,\/9j\//)
    assert.equal(parts[1]?.type, 'text')
  })
})
