<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed } from 'vue'

const props = defineProps<{ text: string }>()

const html = computed(() =>
  DOMPurify.sanitize(
    marked.parse(props.text, { async: false, breaks: true, gfm: true }) as string,
    {
      ALLOWED_TAGS: [
        'a',
        'blockquote',
        'br',
        'code',
        'del',
        'em',
        'h1',
        'h2',
        'h3',
        'h4',
        'hr',
        'li',
        'ol',
        'p',
        'pre',
        'strong',
        'table',
        'tbody',
        'td',
        'th',
        'thead',
        'tr',
        'ul',
      ],
      ALLOWED_ATTR: ['href', 'title'],
      ALLOWED_URI_REGEXP: /^https?:\/\//i,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
    },
  ),
)

function openLink(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const link = target.closest('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href')
  if (href && /^https?:\/\//i.test(href)) void window.zhijiApi.system.openExternal(href)
}
</script>

<template>
  <div class="agent-markdown" @click="openLink" v-html="html"></div>
</template>

<style scoped>
.agent-markdown {
  overflow-wrap: anywhere;
  line-height: 1.65;
}
.agent-markdown :deep(> :first-child) {
  margin-top: 0;
}
.agent-markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.agent-markdown :deep(p),
.agent-markdown :deep(blockquote),
.agent-markdown :deep(pre),
.agent-markdown :deep(ul),
.agent-markdown :deep(ol),
.agent-markdown :deep(table) {
  margin: 0 0 0.75em;
}
.agent-markdown :deep(ul),
.agent-markdown :deep(ol) {
  padding-left: 1.5em;
}
.agent-markdown :deep(li + li) {
  margin-top: 0.25em;
}
.agent-markdown :deep(h1),
.agent-markdown :deep(h2),
.agent-markdown :deep(h3),
.agent-markdown :deep(h4) {
  margin: 0.9em 0 0.45em;
  line-height: 1.3;
}
.agent-markdown :deep(h1) {
  font-size: 1.35em;
}
.agent-markdown :deep(h2) {
  font-size: 1.22em;
}
.agent-markdown :deep(h3),
.agent-markdown :deep(h4) {
  font-size: 1.08em;
}
.agent-markdown :deep(a) {
  color: #3d7dce;
  text-decoration: underline;
  cursor: pointer;
}
.agent-markdown :deep(blockquote) {
  padding-left: 0.85em;
  border-left: 3px solid #8885;
  color: #6f747c;
}
.agent-markdown :deep(code) {
  padding: 0.12em 0.35em;
  border-radius: 5px;
  background: #14171d12;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 0.92em;
}
.agent-markdown :deep(pre) {
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: #14171d0d;
}
.agent-markdown :deep(pre code) {
  padding: 0;
  background: none;
}
.agent-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.agent-markdown :deep(th),
.agent-markdown :deep(td) {
  padding: 6px 8px;
  border: 1px solid #8884;
  text-align: left;
}
</style>
