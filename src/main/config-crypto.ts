import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

declare const __CONFIG_ENCRYPTION_KEY__: string
const FORMAT = 'jobtrail-encrypted-config'
const envelopeSchema = z.strictObject({
  format: z.literal(FORMAT),
  version: z.literal(1),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
})

export function configEncryptionKey(): Buffer {
  if (
    typeof __CONFIG_ENCRYPTION_KEY__ !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(__CONFIG_ENCRYPTION_KEY__)
  )
    throw new Error('Configuration encryption key is not configured')
  return Buffer.from(__CONFIG_ENCRYPTION_KEY__, 'hex')
}

export function encryptConfig(value: unknown): string {
  const secret = configEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secret, iv)
  cipher.setAAD(Buffer.from(FORMAT + ':1'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return (
    JSON.stringify({
      format: FORMAT,
      version: 1,
      keyId: createHash('sha256').update(secret).digest('hex').slice(0, 16),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }) + '\n'
  )
}

export function decryptConfig(contents: string): unknown {
  const envelope = envelopeSchema.parse(JSON.parse(contents))
  const secret = configEncryptionKey()
  if (envelope.keyId !== createHash('sha256').update(secret).digest('hex').slice(0, 16))
    throw new Error('Invalid encrypted configuration')
  const bytes = (value: string): Buffer => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid configuration encoding')
    const result = Buffer.from(value, 'base64')
    if (result.toString('base64') !== value) throw new Error('Invalid configuration encoding')
    return result
  }
  const iv = bytes(envelope.iv)
  const tag = bytes(envelope.tag)
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid configuration authentication')
  const decipher = createDecipheriv('aes-256-gcm', secret, iv)
  decipher.setAAD(Buffer.from(FORMAT + ':1'))
  decipher.setAuthTag(tag)
  return JSON.parse(
    Buffer.concat([decipher.update(bytes(envelope.ciphertext)), decipher.final()]).toString('utf8'),
  )
}
