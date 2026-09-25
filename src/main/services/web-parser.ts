import { load } from 'cheerio'
import { validateWebUrl } from './web-network'

export interface ParsedWebPage {
  title: string | null
  description: string | null
  text: string
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; url: string }>
  appearsDynamic: boolean
}

function clean(value: unknown, limit = 500): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim().slice(0, limit)
  return text || null
}

function absolute(value: string | undefined, base: string): string | null {
  if (!value) return null
  try {
    return validateWebUrl(new URL(value, base).href).href
  } catch {
    return null
  }
}

export function parseWebPage(html: string, base: string): ParsedWebPage {
  const $ = load(html)
  const title = clean($('title').first().text())
  const description = clean($('meta[name="description"]').attr('content'), 1_000)
  const headings = $('h1,h2,h3')
    .toArray()
    .flatMap((element) => {
      const text = clean($(element).text(), 200)
      return text ? [{ level: Number(element.tagName[1]), text }] : []
    })
  const content = $('main').first().length ? $('main').first() : $('body')
  const contentLinks = content.find('a[href]').toArray()
  const links: ParsedWebPage['links'] = []
  const seenLinks = new Set<string>()
  for (const element of [...contentLinks, ...$('a[href]').toArray()]) {
    const url = absolute($(element).attr('href'), base)
    const text = clean($(element).text(), 120)
    if (!url || !text || seenLinks.has(url)) continue
    seenLinks.add(url)
    links.push({ text, url })
  }
  $('script,style,template,noscript,svg,nav,footer,header,iframe,form').remove()
  content.find('p,div,li,br,section,article,h1,h2,h3').after(' ')
  const text = content.text().replace(/\s+/g, ' ').trim()
  return {
    title,
    description,
    text,
    headings,
    links,
    appearsDynamic:
      text.length < 250 && /id=["'](?:root|app|__next)["']|__NEXT_DATA__|<script/i.test(html),
  }
}
