const fs = require('node:fs')

const report = process.env.JOBTRAIL_TEST_NETWORK_REPORT
if (!report) throw new Error('Missing packaged agent network test report')
const record = (event) =>
  fs.appendFileSync(report, `${JSON.stringify({ pid: process.pid, ...event })}\n`)
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const hostname = new URL(url).hostname
  if (hostname !== '127.0.0.1') {
    record({ kind: 'blocked', hostname })
    throw new DOMException('External fetch disabled in packaged agent test', 'AbortError')
  }
  return fetch(input, init)
}
record({ kind: 'ready' })
require(process.argv[2])
