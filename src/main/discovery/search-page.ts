import type { WebContents } from 'electron'
import { z } from 'zod'
import { SourceError, type ResponseReader, type SearchTransport } from './adapter'
import type { PageSnapshot } from './extraction'
import { record } from './parsing'
import { captureError } from '../diagnostics'
import { needsHumanAction } from '../../shared/job-discovery'

import { bounded, wait } from './async-control'

const requestEvent = z.object({
  requestId: z.string(),
  request: z.object({ url: z.string(), method: z.string(), postData: z.string().optional() }),
})
const finishedEvent = z.object({ requestId: z.string(), encodedDataLength: z.number() })
const bodyResult = z.object({ body: z.string(), base64Encoded: z.boolean() })

/** Owned Chromium page transport; all site behavior belongs to platform adapters. */
export class SearchPage implements SearchTransport {
  constructor(
    readonly contents: WebContents,
    private readonly stateScript: string,
  ) {}
  async evaluate<T>(script: string, signal: AbortSignal): Promise<T> {
    if (this.contents.isDestroyed()) throw new SourceError('network_error', 'page_closed')
    return bounded(this.contents.executeJavaScript(script, true) as Promise<T>, signal)
  }
  async load(url: string, signal: AbortSignal) {
    let ready = () => {}
    const dom = new Promise<void>((resolve) => {
      ready = resolve
      this.contents.once('dom-ready', ready)
    })
    try {
      await bounded(
        Promise.race([
          dom,
          this.contents.loadURL(url).catch((error) => {
            if (!/ERR_ABORTED/.test(String(error)))
              throw new SourceError('network_error', 'navigation_failed', { cause: error })
            return dom
          }),
        ]),
        signal,
      )
    } finally {
      this.contents.removeListener('dom-ready', ready)
    }
  }
  async until<T>(
    read: () => Promise<T | null | false>,
    signal: AbortSignal,
    failure = 'control_not_found',
  ): Promise<T> {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      let value: T | null | false
      try {
        value = await read()
      } catch (error) {
        if (!/Execution context was destroyed/.test(String(error))) throw error
        await wait(200, signal)
        continue
      }
      if (value !== null && value !== false) return value
      await this.guard(signal)
      await wait(200, signal)
    }
    throw new SourceError('scope_unverified', failure)
  }
  async guard(signal: AbortSignal) {
    const state = await this.evaluate<PageSnapshot>(this.stateScript, signal)
    if (state.challenge) throw new SourceError('challenge')
    if (state.login) throw new SourceError('login_required')
  }

  async fill(selector: string, value: string, signal: AbortSignal) {
    await this.until(
      () =>
        this.evaluate<boolean>(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e||!e.getBoundingClientRect().width)return false;
      e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
      e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
          signal,
        ),
      signal,
    )
  }
  async click(selector: string, label: string | null, signal: AbortSignal) {
    await this.until(
      () =>
        this.evaluate<boolean>(
          `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0&&!e.disabled&&(${JSON.stringify(label)}===null||e.textContent.trim()===${JSON.stringify(label)}));if(!e)return false;e.click();return true})()`,
          signal,
        ),
      signal,
    )
  }
  enter() {
    this.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    this.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  async response<T>(
    reader: ResponseReader<T>,
    action: () => Promise<void>,
    signal: AbortSignal,
    initial?: () => Promise<T | null>,
  ): Promise<T> {
    // A fresh BrowserWindow has no renderer yet. Initialize it before enabling
    // Network so the first navigation can also be observed without hanging CDP.
    if (!this.contents.getURL()) await bounded(this.contents.loadURL('about:blank'), signal)
    const protocol = this.contents.debugger
    if (!protocol.isAttached()) protocol.attach('1.3')
    await bounded(
      protocol.sendCommand('Network.enable', {
        maxResourceBufferSize: 4_000_000,
        maxTotalBufferSize: 8_000_000,
      }),
      signal,
    )
    const pending = new Set<string>()
    const work = new Set<Promise<void>>()
    let result: T | null = null,
      failure: unknown,
      observed = false,
      latest = ''
    const listener = (_event: Electron.Event, method: string, payload: unknown) => {
      if (method === 'Network.requestWillBeSent') {
        const parsed = requestEvent.safeParse(payload)
        if (!parsed.success) return
        const { requestId, request } = parsed.data
        try {
          const decision = reader.request({
            url: request.url,
            method: request.method,
            body: request.postData ?? '',
          })
          if (decision !== null) {
            observed = true
            latest = requestId
            result = null
            failure = undefined
            if (decision) pending.add(requestId)
          }
        } catch (error) {
          failure = error
        }
      } else if (method === 'Network.loadingFinished') {
        const parsed = finishedEvent.safeParse(payload)
        if (
          !parsed.success ||
          !pending.delete(parsed.data.requestId) ||
          parsed.data.requestId !== latest
        )
          return
        if (parsed.data.encodedDataLength > 4_000_000) {
          failure = new SourceError('network_error', 'response_too_large')
          return
        }
        const task = protocol
          .sendCommand('Network.getResponseBody', { requestId: parsed.data.requestId })
          .catch((error) => {
            throw new SourceError('network_error', 'search_response_failed', { cause: error })
          })
          .then((value) => {
            const parsedBody = bodyResult.safeParse(value)
            if (!parsedBody.success)
              throw new SourceError('network_error', 'search_response_failed')
            const body = parsedBody.data
            const decoded = body.base64Encoded
              ? Buffer.from(body.body, 'base64').toString('utf8')
              : body.body
            if (decoded.length > 4_000_000)
              throw new SourceError('network_error', 'response_too_large')
            if (parsed.data.requestId === latest)
              result = reader.response(
                reader.parseBody ? reader.parseBody(decoded) : JSON.parse(decoded),
              )
          })
          .catch((error) => {
            if (parsed.data.requestId === latest) failure = error
          })
          .finally(() => work.delete(task))
        work.add(task)
      } else if (method === 'Network.loadingFailed') {
        const id = record(payload).requestId
        if (typeof id === 'string' && pending.delete(id) && id === latest)
          failure = new SourceError('network_error', 'search_response_failed')
      }
    }
    protocol.on('message', listener)
    try {
      await action()
      return await this.until(
        async () => {
          if (failure)
            throw failure instanceof SourceError
              ? failure
              : new SourceError('parse_error', 'response_contract_changed', { cause: failure })
          if (result !== null) return result
          return !observed && initial ? initial() : null
        },
        signal,
        'query_not_observed',
      )
    } catch (error) {
      // An official login/challenge response explains controls disappearing.
      if (
        error instanceof SourceError &&
        error.state === 'scope_unverified' &&
        failure instanceof SourceError &&
        needsHumanAction(failure.state)
      )
        throw failure
      // A verification redirect can discard the response body before Chromium
      // delivers it. Prefer the current official page's human-action evidence
      // to a transport/parser failure, without masking cancellation.
      if (
        !signal.aborted &&
        error instanceof SourceError &&
        ['scope_unverified', 'network_error', 'parse_error'].includes(error.state)
      ) {
        try {
          await this.guard(signal)
        } catch (pageError) {
          if (pageError instanceof SourceError && needsHumanAction(pageError.state)) throw pageError
        }
      }
      throw error
    } finally {
      protocol.removeListener('message', listener)
      await bounded(Promise.allSettled([...work]), AbortSignal.timeout(2000)).catch((error) => {
        captureError(error, { operation: 'discovery.response-cleanup', level: 'warn' })
      })
      if (!this.contents.isDestroyed() && protocol.isAttached()) protocol.detach()
    }
  }
}
