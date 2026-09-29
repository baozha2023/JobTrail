import { execFileSync } from 'node:child_process'

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function registryValue(name) {
  try {
    const output = execFileSync('reg.exe', ['query', INTERNET_SETTINGS, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'm'))?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

export function parseReleaseProxy(value) {
  if (!value) return null
  const entries = value.split(';').map((entry) => entry.trim())
  const selected =
    entries.find((entry) => /^https=/i.test(entry)) ??
    entries.find((entry) => /^http=/i.test(entry)) ??
    (entries.length === 1 && !entries[0].includes('=') ? entries[0] : null)
  if (!selected) return null
  const address = selected.replace(/^(?:https|http)=/i, '')
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
    throw new Error('unsupported_release_proxy')
  return url.href
}

export function releaseProxyUrl() {
  const environment = process.env.HTTPS_PROXY ?? process.env.https_proxy
  if (environment) return parseReleaseProxy(environment)
  if (process.platform !== 'win32' || Number(registryValue('ProxyEnable')) !== 1) return null
  return parseReleaseProxy(registryValue('ProxyServer'))
}
