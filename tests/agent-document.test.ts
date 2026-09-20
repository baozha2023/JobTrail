import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractDocument } from '../src/main/agent/document'
import { onePagePdf } from './helpers/pdf'
import { storedZip } from './helpers/zip'

describe('agent document extraction', () => {
  const roots: string[] = []
  afterEach(() =>
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
  )

  it('combines PDF text with rendered pages only when multimodal is enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-document-'))
    roots.push(root)
    const file = path.join(root, 'resume.pdf')
    fs.writeFileSync(file, onePagePdf('TypeScript resume'))

    const textOnly = await extractDocument(file, false)
    expect(textOnly.text).toContain('TypeScript resume')
    expect(textOnly.visuals).toEqual([])
    expect(textOnly.omittedVisuals).toBe(0)

    const multimodal = await extractDocument(file, true)
    expect(multimodal.text).toContain('TypeScript resume')
    expect(multimodal.visuals).toHaveLength(1)
    expect(multimodal.visuals[0].label).toBe('PDF 第 1 页')
    expect(multimodal.visuals[0].mimeType).toBe('image/png')
    expect(multimodal.visuals[0].data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('keeps an image-only PDF usable without throwing when text is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-scanned-document-'))
    roots.push(root)
    const file = path.join(root, 'scan.pdf')
    fs.writeFileSync(file, onePagePdf())

    await expect(extractDocument(file, false)).resolves.toEqual({
      text: '',
      visuals: [],
      omittedVisuals: 0,
    })
    const multimodal = await extractDocument(file, true)
    expect(multimodal.text).toBe('')
    expect(multimodal.visuals).toHaveLength(1)
  })

  it('extracts embedded Markdown images and removes their base64 from text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-markdown-document-'))
    roots.push(root)
    const file = path.join(root, 'resume.md')
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    fs.writeFileSync(file, `# Resume\n![portfolio](${`data:image/png;base64,${image}`})`)

    const textOnly = await extractDocument(file, false)
    expect(textOnly.text).toContain('[图片：portfolio]')
    expect(textOnly.text).not.toContain(image)
    expect(textOnly.visuals).toEqual([])

    const multimodal = await extractDocument(file, true)
    expect(multimodal.visuals).toHaveLength(1)
    expect(multimodal.visuals[0].label).toBe('portfolio')
  })

  it('keeps DOCX body text and adds supported embedded media', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-docx-document-'))
    roots.push(root)
    const file = path.join(root, 'resume.docx')
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    fs.writeFileSync(
      file,
      storedZip([
        {
          name: '[Content_Types].xml',
          data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        },
        {
          name: 'word/document.xml',
          data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Java resume</w:t></w:r></w:p></w:body></w:document>`,
        },
        { name: 'word/media/image1.png', data: image },
      ]),
    )

    const textOnly = await extractDocument(file, false)
    expect(textOnly.text).toContain('Java resume')
    expect(textOnly.visuals).toEqual([])

    const multimodal = await extractDocument(file, true)
    expect(multimodal.text).toContain('Java resume')
    expect(multimodal.visuals).toHaveLength(1)
    expect(multimodal.visuals[0]).toMatchObject({
      label: 'Word 内嵌图片 1',
      mimeType: 'image/png',
    })
  })
})
