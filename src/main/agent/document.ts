import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import WordExtractor from 'word-extractor'
import yauzl from 'yauzl'

const MAX_VISUALS = 20
const MAX_VISUAL_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_VISUAL_BYTES = 20 * 1024 * 1024
const PDF_PAGE_WIDTH = 1_200
const DOCUMENT_CACHE_SIZE = 12
const documentCache = new Map<string, Promise<ExtractedDocument>>()

export interface DocumentVisual {
  data: Buffer
  label: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

export interface ExtractedDocument {
  text: string
  visuals: DocumentVisual[]
  omittedVisuals: number
}

function imageMime(fileName: string): DocumentVisual['mimeType'] | null {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return null
  }
}

function validImage(mimeType: DocumentVisual['mimeType'], data: Buffer): boolean {
  if (mimeType === 'image/png') return data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (mimeType === 'image/jpeg') return data.subarray(0, 3).toString('hex') === 'ffd8ff'
  if (mimeType === 'image/webp')
    return data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
  return data.subarray(0, 6).toString() === 'GIF87a' || data.subarray(0, 6).toString() === 'GIF89a'
}

function readZipEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('无法读取 DOCX 图片'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_VISUAL_BYTES) stream.destroy(new Error('DOCX 图片过大'))
        else chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

async function extractDocxVisuals(filePath: string): Promise<{
  visuals: DocumentVisual[]
  omittedVisuals: number
}> {
  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, file) => {
      if (error || !file) reject(error ?? new Error('无法打开 DOCX'))
      else resolve(file)
    })
  })
  const visuals: DocumentVisual[] = []
  const hashes = new Set<string>()
  let omittedVisuals = 0
  let totalBytes = 0
  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once('error', reject)
      zipFile.once('end', resolve)
      zipFile.on('entry', async (entry) => {
        try {
          if (!/^word\/media\/[^/]+$/i.test(entry.fileName)) {
            zipFile.readEntry()
            return
          }
          const mimeType = imageMime(entry.fileName)
          if (
            !mimeType ||
            entry.uncompressedSize <= 0 ||
            entry.uncompressedSize > MAX_VISUAL_BYTES ||
            visuals.length >= MAX_VISUALS ||
            totalBytes + entry.uncompressedSize > MAX_TOTAL_VISUAL_BYTES
          ) {
            omittedVisuals++
            zipFile.readEntry()
            return
          }
          const data = await readZipEntry(zipFile, entry)
          if (totalBytes + data.length > MAX_TOTAL_VISUAL_BYTES || !validImage(mimeType, data)) {
            omittedVisuals++
            zipFile.readEntry()
            return
          }
          const hash = crypto.createHash('sha256').update(data).digest('hex')
          if (!hashes.has(hash)) {
            hashes.add(hash)
            totalBytes += data.length
            visuals.push({
              data,
              label: `Word 内嵌图片 ${visuals.length + 1}`,
              mimeType,
            })
          }
          zipFile.readEntry()
        } catch {
          omittedVisuals++
          zipFile.readEntry()
        }
      })
      zipFile.readEntry()
    })
  } finally {
    zipFile.close()
  }
  return { visuals, omittedVisuals }
}

async function extractPdf(filePath: string, includeVisuals: boolean): Promise<ExtractedDocument> {
  const parser = new PDFParse({ data: fs.readFileSync(filePath) })
  let text = ''
  let totalPages = 0
  const visuals: DocumentVisual[] = []
  try {
    try {
      const result = await parser.getText({ pageJoiner: '' })
      text = result.pages
        .map((page) => page.text.trim())
        .filter(Boolean)
        .join('\n\n')
      totalPages = result.total
    } catch {
      // A damaged text layer must not prevent visual understanding of readable pages.
    }
    if (includeVisuals) {
      try {
        const screenshots = await parser.getScreenshot({
          desiredWidth: PDF_PAGE_WIDTH,
          first: MAX_VISUALS,
          imageDataUrl: false,
          imageBuffer: true,
        })
        totalPages ||= screenshots.total
        let totalBytes = 0
        for (const page of screenshots.pages) {
          const data = Buffer.from(page.data)
          if (
            data.length > 0 &&
            data.length <= MAX_VISUAL_BYTES &&
            totalBytes + data.length <= MAX_TOTAL_VISUAL_BYTES
          ) {
            totalBytes += data.length
            visuals.push({ data, label: `PDF 第 ${page.pageNumber} 页`, mimeType: 'image/png' })
          }
        }
      } catch {
        // Preserve extracted text when page rendering is unavailable.
      }
    }
  } finally {
    await parser.destroy()
  }
  return {
    text,
    visuals,
    omittedVisuals: includeVisuals ? Math.max(0, totalPages - visuals.length) : 0,
  }
}

function extractTextFile(filePath: string): string {
  return new TextDecoder('utf-8', { fatal: true })
    .decode(fs.readFileSync(filePath))
    .replace(/^\uFEFF/, '')
    .trim()
}

function extractMarkdown(source: string, includeVisuals: boolean): ExtractedDocument {
  const visuals: DocumentVisual[] = []
  let omittedVisuals = 0
  let totalBytes = 0
  const text = source.replace(
    /!\[([^\]\r\n]{0,200})\]\(data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)\)/gi,
    (_match, alt: string, rawMimeType: string, encoded: string) => {
      if (includeVisuals && visuals.length < MAX_VISUALS) {
        try {
          const mimeType = rawMimeType.toLowerCase() as DocumentVisual['mimeType']
          const data = Buffer.from(encoded.replace(/\s/g, ''), 'base64')
          if (
            data.length > 0 &&
            data.length <= MAX_VISUAL_BYTES &&
            totalBytes + data.length <= MAX_TOTAL_VISUAL_BYTES &&
            validImage(mimeType, data)
          ) {
            totalBytes += data.length
            visuals.push({
              data,
              label: alt.trim() || `Markdown 内嵌图片 ${visuals.length + 1}`,
              mimeType,
            })
          } else omittedVisuals++
        } catch {
          omittedVisuals++
        }
      } else if (includeVisuals) omittedVisuals++
      return alt.trim() ? `[图片：${alt.trim()}]` : '[内嵌图片]'
    },
  )
  return { text: text.trim(), visuals, omittedVisuals }
}

async function extractDocumentUncached(
  filePath: string,
  includeVisuals: boolean,
): Promise<ExtractedDocument> {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.pdf') return extractPdf(filePath, includeVisuals)
  if (extension === '.doc' || extension === '.docx') {
    let text = ''
    try {
      text = (await new WordExtractor().extract(filePath)).getBody().trim()
    } catch {
      // A readable image can still make a DOCX useful when its text layer is damaged.
    }
    if (extension === '.docx' && includeVisuals) {
      try {
        const result = await extractDocxVisuals(filePath)
        return { text, ...result }
      } catch {
        // Preserve extracted text when the Office media package is malformed.
      }
    }
    return { text, visuals: [], omittedVisuals: 0 }
  }
  if (extension === '.md') return extractMarkdown(extractTextFile(filePath), includeVisuals)
  if (extension === '.txt')
    return { text: extractTextFile(filePath), visuals: [], omittedVisuals: 0 }
  return { text: '', visuals: [], omittedVisuals: 0 }
}

export async function extractDocument(
  filePath: string,
  includeVisuals: boolean,
): Promise<ExtractedDocument> {
  const stat = fs.statSync(filePath)
  const key = `${filePath}\0${stat.size}\0${stat.mtimeMs}\0${includeVisuals}`
  const cached = documentCache.get(key)
  if (cached) return cached
  const extraction = extractDocumentUncached(filePath, includeVisuals)
  documentCache.set(key, extraction)
  while (documentCache.size > DOCUMENT_CACHE_SIZE)
    documentCache.delete(documentCache.keys().next().value as string)
  try {
    return await extraction
  } catch (error) {
    documentCache.delete(key)
    throw error
  }
}
