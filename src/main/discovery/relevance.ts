import type { RawJob } from '../../shared/job-discovery'

type Document = Pick<RawJob, 'title' | 'company' | 'jd'> & { id: string }
type Tokens = { words: string[]; grams: string[] }
type Field = { length: number; counts: number[] }
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const fields = [
  { name: 'title', weight: 5, normalization: 0.4 },
  { name: 'company', weight: 2, normalization: 0.3 },
  { name: 'jd', weight: 1, normalization: 0.75 },
] as const

function tokenize(value: string): Tokens {
  const words: string[] = [],
    grams: string[] = []
  for (const part of value
    .normalize('NFKC')
    .toLowerCase()
    .split(/(\p{Script=Han}+)/u)) {
    if (!part) continue
    if (/^\p{Script=Han}/u.test(part)) {
      // Merge adjacent single-character segments without a domain dictionary.
      let singles = ''
      const flush = () => {
        if (singles) words.push(singles)
        singles = ''
      }
      for (const item of segmenter.segment(part)) {
        if (!item.isWordLike) continue
        if ([...item.segment].length === 1) singles += item.segment
        else {
          flush()
          words.push(item.segment)
        }
      }
      flush()
      // Low-weight bigrams recover compounds segmented differently in a longer title/JD.
      const chars = [...part]
      for (let i = 1; i < chars.length; i++) grams.push(chars[i - 1] + chars[i])
    } else {
      // Keep lexical boundaries and meaningful punctuation, including suffixes such as +/#.
      words.push(...(part.match(/\.?[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)*(?:[+#]+)?/gu) ?? []))
    }
  }
  return { words, grams }
}

function containsPhrase(words: string[], phrase: string[]): boolean {
  return phrase.length > 0 && words.some((_, i) => phrase.every((word, j) => words[i + j] === word))
}

/** BM25F over the current search's observations, never a filter or a platform/domain rule. */
export function rankRelevance(
  keyword: string,
  documents: Iterable<Document>,
): { id: string; score: number }[] {
  const query = tokenize(keyword)
  const phrase = [...new Set(query.words)]
  const terms = [
    ...phrase.map((word) => ({ key: `w:${word}`, weight: 1 })),
    ...[...new Set(query.grams)].map((gram) => ({ key: `g:${gram}`, weight: 0.25 })),
  ]
  if (!terms.length) return Array.from(documents, ({ id }) => ({ id, score: 0 }))
  const termIndex = new Map(terms.map((term, index) => [term.key, index]))
  const documentFrequency = terms.map(() => 0)
  const lengths = fields.map(() => 0),
    populated = fields.map(() => 0)
  const corpus: { id: string; fields: Field[]; phrase: boolean; exact: boolean }[] = []
  for (const document of documents) {
    let titleWords: string[] = []
    const analyzed = fields.map((field, index) => {
      const tokens = tokenize(document[field.name])
      if (index === 0) titleWords = tokens.words
      const counts = terms.map(() => 0)
      for (const [prefix, values] of [
        ['w', tokens.words],
        ['g', tokens.grams],
      ] as const)
        for (const word of values) {
          const term = termIndex.get(`${prefix}:${word}`)
          // Repetition saturates; a stuffed description cannot accrue unbounded weight.
          if (term !== undefined) counts[term] = Math.min(counts[term] + 1, 3)
        }
      lengths[index] += tokens.words.length
      if (tokens.words.length) populated[index]++
      return { length: tokens.words.length, counts }
    })
    terms.forEach((_, term) => {
      if (analyzed.some((field) => field.counts[term] > 0)) documentFrequency[term]++
    })
    const matchesPhrase = containsPhrase(titleWords, phrase)
    corpus.push({
      id: document.id,
      fields: analyzed,
      phrase: matchesPhrase,
      exact: matchesPhrase && titleWords.length === phrase.length,
    })
  }
  const averages = lengths.map((length, index) => length / (populated[index] || 1) || 1)
  const weights = terms.map(
    (term, index) =>
      term.weight *
      Math.log1p(
        (corpus.length - documentFrequency[index] + 0.5) / (documentFrequency[index] + 0.5),
      ),
  )
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  return corpus.map((document) => {
    let bm25 = 0,
      matched = 0,
      titleMatched = 0
    terms.forEach((_, term) => {
      let frequency = 0
      document.fields.forEach((field, index) => {
        const { weight, normalization } = fields[index]
        frequency +=
          (weight * field.counts[term]) /
          (1 - normalization + (normalization * field.length) / averages[index])
      })
      if (frequency > 0) matched += weights[term]
      if (document.fields[0].counts[term] > 0) titleMatched += weights[term]
      bm25 += (weights[term] * frequency * 2.2) / (frequency + 1.2)
    })
    const coverage = totalWeight ? matched / totalWeight : 0
    const score =
      bm25 * (0.35 + 0.65 * coverage ** 2) +
      1.5 * titleMatched +
      totalWeight * (document.phrase ? 0.6 : 0) +
      totalWeight * (document.exact ? 0.9 : 0)
    return { id: document.id, score: Math.round(score * 10000) }
  })
}
