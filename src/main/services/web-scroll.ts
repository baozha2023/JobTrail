import type { Frame, Page } from 'playwright'
import { validateWebUrl } from './web-network'

export interface WebTextBlock {
  text: string
  links: Array<{ text: string; url: string }>
}

export interface WebScrollCapture {
  title: string | null
  description: string | null
  blocks: WebTextBlock[]
  headings: Array<{ level: number; text: string }>
  scrollable: boolean
  overflow: boolean
}

interface FrameCapture extends WebScrollCapture {
  candidates: Array<{ index: number; score: number }>
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

async function captureFrame(frame: Frame): Promise<FrameCapture> {
  return frame.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    const excluded = new Set([
      'SCRIPT',
      'STYLE',
      'TEMPLATE',
      'NOSCRIPT',
      'SVG',
      'NAV',
      'FOOTER',
      'HEADER',
      'FORM',
      'IFRAME',
    ])
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const children = (element: Element): Element[] => [
      ...element.children,
      ...(element.shadowRoot ? [...element.shadowRoot.children] : []),
    ]
    const all: Element[] = []
    let overflow = false
    const stack: Array<{ element: Element; depth: number }> = document.body
      ? [{ element: document.body, depth: 0 }]
      : []
    while (stack.length) {
      const { element, depth } = stack.pop()!
      if (excluded.has(element.tagName) || !visible(element)) continue
      if (depth > 256) {
        overflow = true
        continue
      }
      if (all.length >= 20_000) {
        overflow = true
        break
      }
      all.push(element)
      const nested = children(element)
      for (let index = nested.length - 1; index >= 0; index--)
        stack.push({ element: nested[index]!, depth: depth + 1 })
    }
    const text = (element: Element) =>
      normalize((element as HTMLElement).innerText || element.textContent || '')
    const blocks: Array<{ text: string; links: Array<{ text: string; url: string }> }> = []
    const maxCaptureUnits = 2_000_000
    let captureUnits = 0
    let linkCount = 0
    const appendLink = (
      links: Array<{ text: string; url: string }>,
      label: string,
      url: string,
    ): boolean => {
      if (!label || !url || url.length > 2_048) return true
      if (linkCount >= 5_000 || captureUnits + label.length + url.length > maxCaptureUnits) {
        overflow = true
        return false
      }
      links.push({ text: label, url })
      linkCount++
      captureUnits += label.length + url.length
      return true
    }
    const captured = new Set<Element>()
    const siblingCounts = new WeakMap<Element, Map<string, number>>()
    const contained = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (captured.has(parent)) return true
      return false
    }
    const repeated = (element: Element, className: string): boolean => {
      const parent = element.parentElement
      if (!parent || parent.children.length < 3) return false
      let counts = siblingCounts.get(parent)
      if (!counts) {
        counts = new Map()
        for (const sibling of parent.children) {
          const name = typeof sibling.className === 'string' ? sibling.className : ''
          const key = `${sibling.tagName}\n${name}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        siblingCounts.set(parent, counts)
      }
      return (counts.get(`${element.tagName}\n${className}`) ?? 0) >= 3
    }
    for (const element of all) {
      if (contained(element)) continue
      const semantic = element.matches('article,li,[role="listitem"]')
      const className = typeof element.className === 'string' ? element.className : ''
      const namedCard = /(?:card|item|entry|result|row)/i.test(className)
      if (!semantic && !namedCard && !repeated(element, className)) continue
      const value = text(element)
      if (!value) continue
      if (captureUnits + value.length > maxCaptureUnits) {
        overflow = true
        break
      }
      captured.add(element)
      captureUnits += value.length
      const links: Array<{ text: string; url: string }> = []
      for (const anchor of element.querySelectorAll('a[href]'))
        if (
          !appendLink(
            links,
            normalize((anchor as HTMLElement).innerText || anchor.textContent || '').slice(0, 120),
            (anchor as HTMLAnchorElement).href,
          )
        )
          break
      blocks.push({ text: value, links })
      if (overflow) break
    }
    for (const element of all) {
      if (contained(element) || captured.has(element)) continue
      if (!element.matches('h1,h2,h3,p,a[href]')) continue
      const value = text(element)
      if (!value) continue
      if (captureUnits + value.length > maxCaptureUnits) {
        overflow = true
        break
      }
      captureUnits += value.length
      const anchor = element.closest('a[href]') as HTMLAnchorElement | null
      const links: Array<{ text: string; url: string }> = []
      if (anchor && !appendLink(links, value.slice(0, 120), anchor.href)) break
      blocks.push({ text: value, links })
    }
    const headings: Array<{ level: number; text: string }> = []
    for (const element of all) {
      if (!element.matches('h1,h2,h3')) continue
      const label = text(element).slice(0, 200)
      if (!label) continue
      if (headings.length >= 5_000 || captureUnits + label.length > maxCaptureUnits) {
        overflow = true
        break
      }
      headings.push({ level: Number(element.tagName[1]), text: label })
      captureUnits += label.length
    }
    const roots: Element[] = []
    const scrolling = document.scrollingElement || document.documentElement
    if (scrolling) roots.push(scrolling)
    for (const element of all) {
      if (element === scrolling) continue
      const style = getComputedStyle(element)
      if (!/(auto|scroll)/.test(style.overflowY)) continue
      if (element.clientHeight < 120 || element.scrollHeight - element.clientHeight < 40) continue
      if (roots.length >= 256) {
        overflow = true
        break
      }
      roots.push(element)
    }
    const candidates = roots.flatMap((root, index) => {
      const distance = root.scrollHeight - root.clientHeight
      const remaining = distance - root.scrollTop
      if (distance < 40 || remaining <= 2) return []
      const itemCount = all.filter((element) => {
        if (!root.contains(element)) return false
        if (element.matches('article,li,[role="listitem"]')) return true
        const name = typeof element.className === 'string' ? element.className : ''
        return /(?:card|item|entry|result|row)/i.test(name)
      }).length
      const inMain = !!root.closest('main,[role="main"]')
      const score =
        itemCount * 100 +
        Math.min(remaining, 5000) / 10 +
        (root === scrolling ? 0 : 600) +
        (inMain ? 300 : 0)
      return [{ index, score }]
    })
    return {
      title: document.title.slice(0, 500) || null,
      description:
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content')
          ?.slice(0, 1_000) || null,
      blocks,
      headings,
      scrollable: candidates.length > 0,
      overflow,
      candidates,
    }
  })
}

export async function captureWebScroll(page: Page): Promise<WebScrollCapture> {
  const pageFrames = page.frames()
  const frames = await Promise.all(
    pageFrames.slice(0, 16).map((frame) => captureFrame(frame).catch(() => null)),
  )
  const blocks: WebTextBlock[] = []
  const headings: WebScrollCapture['headings'] = []
  let units = 0
  let overflow = pageFrames.length > 16 || frames.some((frame) => frame?.overflow)
  let exhausted = false
  for (const frame of frames) {
    if (!frame) continue
    for (const block of frame.blocks) {
      const links = block.links.flatMap((link) => {
        try {
          return [{ text: clean(link.text).slice(0, 120), url: validateWebUrl(link.url).href }]
        } catch {
          return []
        }
      })
      const size =
        block.text.length + links.reduce((sum, link) => sum + link.text.length + link.url.length, 0)
      if (units + size > 2_000_000) {
        overflow = true
        exhausted = true
        break
      }
      blocks.push({ text: clean(block.text), links })
      units += size
    }
    if (exhausted) break
    for (const heading of frame.headings) {
      if (units + heading.text.length > 2_000_000) {
        overflow = true
        exhausted = true
        break
      }
      headings.push(heading)
      units += heading.text.length
    }
    if (exhausted) break
  }
  return {
    title: frames[0]?.title ?? null,
    description: frames[0]?.description ?? null,
    blocks,
    headings,
    scrollable: frames.some((frame) => frame?.scrollable),
    overflow,
  }
}

export async function scrollWebPage(page: Page): Promise<{ moved: boolean; atBottom: boolean }> {
  const pageFrames = page.frames().slice(0, 16)
  const frames = await Promise.all(pageFrames.map((frame) => captureFrame(frame).catch(() => null)))
  const options = frames.flatMap(
    (capture, frameIndex) =>
      capture?.candidates.map((candidate) => ({ frameIndex, ...candidate })) ?? [],
  )
  options.sort((a, b) => b.score - a.score)
  const selected = options[0]
  if (!selected) return { moved: false, atBottom: true }
  const frame = pageFrames[selected.frameIndex]
  if (!frame) return { moved: false, atBottom: true }
  return frame.evaluate((index) => {
    const excluded = new Set([
      'SCRIPT',
      'STYLE',
      'TEMPLATE',
      'NOSCRIPT',
      'SVG',
      'NAV',
      'FOOTER',
      'HEADER',
      'FORM',
      'IFRAME',
    ])
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const roots: Element[] = []
    const scrolling = document.scrollingElement || document.documentElement
    if (scrolling) roots.push(scrolling)
    const stack: Array<{ element: Element; depth: number }> = document.body
      ? [{ element: document.body, depth: 0 }]
      : []
    let visited = 0
    while (stack.length && visited < 20_000 && roots.length < 256) {
      const { element, depth } = stack.pop()!
      if (excluded.has(element.tagName) || !visible(element) || depth > 256) continue
      visited++
      if (element !== scrolling) {
        const style = getComputedStyle(element)
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          element.clientHeight >= 120 &&
          element.scrollHeight - element.clientHeight >= 40
        )
          roots.push(element)
      }
      const nested = [
        ...element.children,
        ...(element.shadowRoot ? [...element.shadowRoot.children] : []),
      ]
      for (let child = nested.length - 1; child >= 0; child--)
        stack.push({ element: nested[child]!, depth: depth + 1 })
    }
    const root = roots[index] as HTMLElement | undefined
    if (!root) return { moved: false, atBottom: true }
    const before = root.scrollTop
    root.scrollTop = Math.min(
      root.scrollHeight - root.clientHeight,
      before + Math.max(120, Math.floor(root.clientHeight * 0.8)),
    )
    const moved = root.scrollTop > before + 1
    return { moved, atBottom: root.scrollTop >= root.scrollHeight - root.clientHeight - 2 }
  }, selected.index)
}
