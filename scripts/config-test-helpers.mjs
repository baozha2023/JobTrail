// Independent codec for packaged smoke tests; never shipped as a migration tool.
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
const format = 'jobtrail-encrypted-config'
export function privateTestKey() {
  return Buffer.from(
    JSON.parse(fs.readFileSync(path.resolve('private-build.config.json'), 'utf8'))
      .configEncryptionKey,
    'hex',
  )
}
export function encodeTestConfig(value, key = privateTestKey()) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(format + ':1'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return (
    JSON.stringify({
      format,
      version: 1,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }) + '\n'
  )
}
export function decodeTestConfig(contents, key = privateTestKey()) {
  const value = JSON.parse(contents)
  if (value.format !== format || value.version !== 1)
    throw new Error('Expected encrypted test configuration')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(format + ':1'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString(),
  )
}
