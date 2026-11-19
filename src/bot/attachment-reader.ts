// Reading an attachment for a question: the checks before the download, the
// capped download and turning the file into what the provider takes.
import { MaxBytesExceededError, NotFoundError, type Attachment, type Client } from '@mnema-xyz/bot-sdk'
import type { Logger } from '../log.ts'
import type { MediaAttachment } from '../providers/types.ts'
import { extractPdfText, processImage, readStreamWithCap, type AttachmentClassification } from './attachments.ts'
import { maxAttachmentBytes, type BotSettings } from './settings.ts'

/** What a question gets from its attachment: media for the provider, or text
 * to put before the question. */
export interface ReadAttachment {
  attachments?: MediaAttachment[]
  textPrefix?: string
}

/** Text files are cut to this many characters. */
const MAX_TEXT_CHARS = 40_000

/** Why an attachment is not read, before anything is downloaded. */
export function attachmentRefusal(s: BotSettings, attachment: Attachment, classification: AttachmentClassification): string | undefined {
  if (s.attachments?.enabled === false) return "I can't read attachments."
  const size = attachment.size_bytes || (attachment.size ?? 0)
  if (size > maxAttachmentBytes(s)) {
    const mb = (size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')
    return `This file is ${mb} MB; I can only read attachments up to 10 MB.`
  }
  if (classification.type === 'unsupported') return `I can't read ${classification.fileType} files yet.`
  if (classification.type === 'image' && s.vision === false) return 'The configured model does not support image input.'
  return undefined
}

export interface ReaderDeps {
  client: Client
  log: Logger
  /** The provider's name: Anthropic takes PDFs as documents. */
  providerName: string
  maxBytes: number
}

/** The file, capped at maxBytes; a string is the refusal to post. */
export async function downloadFile(d: ReaderDeps, attachment: Attachment): Promise<DownloadedFile | string> {
  try {
    const downloaded = await d.client.rest.downloadAttachment(attachment.id, { maxBytes: d.maxBytes, signal: AbortSignal.timeout(30_000) })
    const buffer = await readStreamWithCap(downloaded.stream, d.maxBytes)
    return { buffer, contentType: downloaded.contentType || attachment.content_type || attachment.mime_type }
  } catch (err) {
    if (err instanceof NotFoundError) return 'Reading attachments requires Talk 3.3 or newer.'
    if (err instanceof MaxBytesExceededError) return 'This file is too large; I can only read attachments up to 10 MB.'
    d.log.warn('attachment_download_failed', { error: err })
    return 'Sorry, I could not download the attachment. Try again in a moment.'
  }
}

export interface DownloadedFile {
  buffer: Buffer
  contentType: string
}

/** What the provider gets from the file; a string is the refusal to post,
 * undefined a type that is not read at all. */
export async function convertFile(
  d: ReaderDeps,
  attachment: Attachment,
  classification: AttachmentClassification,
  file: DownloadedFile,
): Promise<ReadAttachment | string | undefined> {
  d.log.info('attachment_read', { type: file.contentType, size: file.buffer.length })
  switch (classification.type) {
    case 'image':
      try {
        const processed = await processImage(file.buffer, file.contentType)
        return { attachments: [{ type: 'image', mediaType: processed.mediaType, data: processed.data }] }
      } catch (err) {
        d.log.warn('image_processing_failed', { error: err })
        return 'Sorry, I could not process that image.'
      }
    case 'pdf': {
      if (d.providerName === 'anthropic') {
        return { attachments: [{ type: 'document', mediaType: 'application/pdf', data: file.buffer.toString('base64') }] }
      }
      const fname = attachment.original_filename || attachment.filename || 'document.pdf'
      return { textPrefix: `Attachment (${fname}):\n${extractPdfText(file.buffer) || '[No extractable text]'}` }
    }
    case 'text': {
      let text = file.buffer.toString('utf-8')
      if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[... content truncated ...]`
      const fname = attachment.original_filename || attachment.filename || 'file'
      return { textPrefix: `Attachment (${fname}):\n\`\`\`\n${text}\n\`\`\`` }
    }
    default:
      return undefined
  }
}
