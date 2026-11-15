// Attachment handling for Mnemo: classification, consent prompt, download,
// image downscaling with sharp, PDF text extraction and stream capping.
import { inflateSync } from 'node:zlib'
import {
  actionRow,
  button,
  ButtonStyle,
  MaxBytesExceededError,
  type Attachment,
} from '@mnema-xyz/bot-sdk'
import sharp from 'sharp'
import { customId } from './delivery.ts'

export type AttachmentType = 'image' | 'pdf' | 'text' | 'unsupported'

export interface AttachmentClassification {
  type: AttachmentType
  fileType: string
  mimeType: string
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'c', 'cpp', 'h',
  'hpp', 'java', 'sh', 'bash', 'zsh', 'sql', 'env', 'toml', 'ini', 'conf', 'diff', 'patch',
])

const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv'])
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export function classifyAttachment(att: Attachment): AttachmentClassification {
  const mime = (att.content_type || att.mime_type || '').toLowerCase()
  const name = (att.filename || att.original_filename || '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''

  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) {
    return { type: 'image', fileType: 'image', mimeType: mime || `image/${ext || 'jpeg'}` }
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return { type: 'pdf', fileType: 'pdf', mimeType: 'application/pdf' }
  }
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return { type: 'text', fileType: ext || 'text', mimeType: mime || 'text/plain' }
  }

  let fileType = ext || 'binary'
  if (ARCHIVE_EXTS.has(ext) || mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) {
    fileType = 'zip'
  } else if (AUDIO_EXTS.has(ext) || mime.startsWith('audio/')) {
    fileType = 'audio'
  } else if (VIDEO_EXTS.has(ext) || mime.startsWith('video/')) {
    fileType = 'video'
  } else if (OFFICE_EXTS.has(ext) || mime.includes('word') || mime.includes('sheet') || mime.includes('presentation') || mime.includes('officedocument')) {
    fileType = 'office'
  }
  return { type: 'unsupported', fileType, mimeType: mime || 'application/octet-stream' }
}

export function consentPromptText(
  classification: AttachmentClassification,
  providerName: string,
  isLocal: boolean,
): string {
  const subject = classification.type === 'image' ? 'The image' : 'The file'
  if (isLocal) {
    return `${subject} stays on this server and will be processed by the local model. Should I check it anyway?`
  }
  return `${subject} will be shared with ${providerName}. Should I check it anyway?`
}

export function consentButtons(consentId: string) {
  return [
    actionRow(
      button({ customId: customId('consent_yes', consentId), label: 'Yes, check it', style: ButtonStyle.Primary }),
      button({ customId: customId('consent_no', consentId), label: 'No', style: ButtonStyle.Secondary }),
    ),
  ]
}

export async function readStreamWithCap(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new MaxBytesExceededError(maxBytes, total)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

export async function processImage(
  buffer: Buffer,
  mimeType: string,
): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  let s = sharp(buffer, { pages: 1 })
  const meta = await s.metadata()
  const MAX_PX = 8000
  const MAX_BYTES = 4.5 * 1024 * 1024

  const width = meta.width
  const height = meta.height
  const needsResize = width > MAX_PX || height > MAX_PX || buffer.length > MAX_BYTES

  if (needsResize) {
    s = s.resize({
      width: Math.min(width || 2048, 2048),
      height: Math.min(height || 2048, 2048),
      fit: 'inside',
      withoutEnlargement: true,
    })
  }

  let targetMime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg'
  if (mimeType.includes('png')) targetMime = 'image/png'
  else if (mimeType.includes('webp')) targetMime = 'image/webp'
  else if (mimeType.includes('gif')) targetMime = 'image/png'

  let out: Buffer
  if (targetMime === 'image/png') out = await s.png().toBuffer()
  else if (targetMime === 'image/webp') out = await s.webp().toBuffer()
  else out = await s.jpeg({ quality: 85 }).toBuffer()

  if (out.length > MAX_BYTES) {
    out = await sharp(out).resize({ width: 1024, height: 1024, fit: 'inside' }).jpeg({ quality: 75 }).toBuffer()
    targetMime = 'image/jpeg'
  }

  return {
    data: out.toString('base64'),
    mediaType: targetMime,
  }
}

export function extractPdfText(buf: Buffer): string {
  const textChunks: string[] = []
  const str = buf.toString('latin1')
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match: RegExpExecArray | null
  while ((match = streamRegex.exec(str)) !== null) {
    const raw = Buffer.from(match[1] ?? '', 'latin1')
    let decoded: string
    try {
      decoded = inflateSync(raw).toString('latin1')
    } catch {
      decoded = raw.toString('latin1')
    }
    const tjRegex = /\((.*?)(?<!\\)\)\s*Tj/g
    let m: RegExpExecArray | null
    while ((m = tjRegex.exec(decoded)) !== null) {
      const unescaped = unescapePdfStr(m[1] ?? '')
      if (unescaped) textChunks.push(unescaped)
    }
    const tjArrayRegex = /\[(.*?)\]\s*TJ/g
    while ((m = tjArrayRegex.exec(decoded)) !== null) {
      const inner = m[1] ?? ''
      const itemRegex = /\((.*?)(?<!\\)\)/g
      let im: RegExpExecArray | null
      while ((im = itemRegex.exec(inner)) !== null) {
        const unescaped = unescapePdfStr(im[1] ?? '')
        if (unescaped) textChunks.push(unescaped)
      }
    }
  }
  return textChunks.join(' ').replace(/\s+/g, ' ').trim()
}

function unescapePdfStr(s: string): string {
  return s
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
}
