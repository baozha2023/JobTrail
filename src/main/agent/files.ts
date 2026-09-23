import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AgentAttachment } from '../../shared/types'
import type { AppPaths } from '../config'
import { AppServiceError } from '../services/errors'
import { extractDocument, type ExtractedDocument } from './document'

type SqliteDatabase = InstanceType<typeof Database>
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_MARKER = /\[附件:([0-9a-f-]{36})\]/g

function validSignature(extension: string, data: Buffer): boolean {
  if (extension === '.pdf') return data.subarray(0, 5).toString() === '%PDF-'
  if (extension === '.doc') return data.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
  if (extension === '.docx') return data.subarray(0, 4).toString('hex') === '504b0304'
  if (extension === '.png') return data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (extension === '.jpg' || extension === '.jpeg')
    return data.subarray(0, 3).toString('hex') === 'ffd8ff'
  if (extension === '.webp')
    return data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
  if (data.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

export class AgentFileStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly db: SqliteDatabase,
  ) {
    fs.mkdirSync(paths.chatUploads, { recursive: true })
    this.assertDirectory()
  }

  private assertDirectory(): void {
    const stat = fs.lstatSync(this.paths.chatUploads)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AppServiceError('FILE_IMPORT_FAILED', '聊天附件目录无效')
  }

  private resolve(relativePath: string): string {
    if (!/^[0-9a-f-]{36}\.(pdf|doc|docx|txt|md|png|jpg|jpeg|webp)$/.test(relativePath))
      throw new AppServiceError('FILE_IMPORT_FAILED', '聊天附件路径无效')
    this.assertDirectory()
    const result = path.join(this.paths.chatUploads, relativePath)
    if (fs.existsSync(result)) {
      const stat = fs.lstatSync(result)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppServiceError('FILE_IMPORT_FAILED', '聊天附件不是普通文件')
    }
    return result
  }

  import(conversationId: string, sourcePath: string, multimodal: boolean): AgentAttachment {
    const extension = path.extname(sourcePath).toLowerCase()
    const mimeType = MIME[extension]
    if (!mimeType) throw new AppServiceError('FILE_IMPORT_FAILED', '不支持的附件类型')
    if (IMAGE_MIME.has(mimeType) && !multimodal)
      throw new AppServiceError('VALIDATION_ERROR', '请先启用多模态图片输入')
    const sourceStat = fs.lstatSync(sourcePath)
    const max = IMAGE_MIME.has(mimeType) ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
    if (
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      sourceStat.size === 0 ||
      sourceStat.size > max
    )
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件必须是大小受限的普通文件')
    const data = fs.readFileSync(sourcePath)
    if (data.length !== sourceStat.size)
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件内容与类型不匹配')
    return this.importBytes(conversationId, path.basename(sourcePath), mimeType, data, multimodal)
  }

  importBytes(
    conversationId: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    multimodal: boolean,
  ): AgentAttachment {
    if (typeof name !== 'string' || typeof mimeType !== 'string' || !(bytes instanceof Uint8Array))
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件参数无效')
    const originalName = path.basename(name)
    if (!originalName || originalName === '.' || originalName === '..' || originalName.length > 255)
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件名称无效')
    const extension = path.extname(originalName).toLowerCase()
    const max = IMAGE_MIME.has(mimeType) ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
    if (MIME[extension] !== mimeType)
      throw new AppServiceError('FILE_IMPORT_FAILED', '不支持的附件类型')
    if (IMAGE_MIME.has(mimeType) && !multimodal)
      throw new AppServiceError('VALIDATION_ERROR', '请先启用多模态图片输入')
    if (bytes.byteLength === 0 || bytes.byteLength > max)
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件大小无效')
    const data = Buffer.from(bytes)
    if (!validSignature(extension, data))
      throw new AppServiceError('FILE_IMPORT_FAILED', '附件内容与类型不匹配')
    const id = crypto.randomUUID()
    const relativePath = `${id}${extension}`
    const destination = this.resolve(relativePath)
    const hash = crypto.createHash('sha256').update(data).digest('hex')
    try {
      fs.writeFileSync(destination, data, { flag: 'wx' })
      this.db
        .prepare(
          `INSERT INTO chat_attachments
        (id, conversation_id, original_name, relative_path, mime_type, size_bytes, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          conversationId,
          originalName,
          relativePath,
          mimeType,
          data.length,
          hash,
          Date.now(),
        )
    } catch (error) {
      fs.rmSync(destination, { force: true })
      throw error
    }
    return { id, conversationId, name: originalName, mimeType, sizeBytes: data.length }
  }

  get(id: string, conversationId: string): AgentAttachment & { relativePath: string } {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, original_name AS name,
      relative_path AS relativePath, mime_type AS mimeType, size_bytes AS sizeBytes
      FROM chat_attachments WHERE id = ? AND conversation_id = ?`,
      )
      .get(id, conversationId) as (AgentAttachment & { relativePath: string }) | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '聊天附件不存在')
    return row
  }

  async content(
    id: string,
    conversationId: string,
    includeVisuals: boolean,
  ): Promise<
    { kind: 'image'; dataUrl: string } | { kind: 'document'; document: ExtractedDocument }
  > {
    const attachment = this.get(id, conversationId)
    const filePath = this.resolve(attachment.relativePath)
    if (IMAGE_MIME.has(attachment.mimeType)) {
      return {
        kind: 'image',
        dataUrl: `data:${attachment.mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`,
      }
    }
    return { kind: 'document', document: await extractDocument(filePath, includeVisuals) }
  }

  preview(id: string, conversationId: string): string | null {
    const attachment = this.get(id, conversationId)
    if (!IMAGE_MIME.has(attachment.mimeType)) return null
    const filePath = this.resolve(attachment.relativePath)
    return `data:${attachment.mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`
  }

  getPath(id: string, conversationId: string): string {
    return this.resolve(this.get(id, conversationId).relativePath)
  }

  remove(id: string, conversationId: string): void {
    const attachment = this.get(id, conversationId)
    const filePath = this.resolve(attachment.relativePath)
    this.db
      .prepare('DELETE FROM chat_attachments WHERE id = ? AND conversation_id = ?')
      .run(id, conversationId)
    try {
      fs.rmSync(filePath, { force: true })
    } catch (error) {
      console.error('清理聊天附件失败', error)
    }
  }

  deleteConversation(conversationId: string): void {
    const rows = this.db
      .prepare(
        'SELECT relative_path AS relativePath FROM chat_attachments WHERE conversation_id = ?',
      )
      .all(conversationId) as { relativePath: string }[]
    this.db.prepare('DELETE FROM chat_attachments WHERE conversation_id = ?').run(conversationId)
    for (const row of rows) {
      try {
        fs.rmSync(this.resolve(row.relativePath), { force: true })
      } catch (error) {
        console.error('清理聊天附件失败', error)
      }
    }
  }
}
