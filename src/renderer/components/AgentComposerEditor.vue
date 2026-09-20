<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  AgentDraftPart,
  AgentReference,
  Company,
  Industry,
  Opportunity,
  ResumeVersion,
} from '../../shared/types'
import { agentPartLabel, agentReferenceLabel } from './agent-reference'

type Category = Extract<AgentReference, { id: number }>['kind']
type Trigger = { kind: 'mention' | 'skill'; node: Text; start: number; end: number; query: string }
type Option =
  | { kind: 'category'; category: Category; label: string; detail: string }
  | {
      kind: 'reference'
      category: Category
      id: number
      label: string
      detail: string
      searchText: string
    }
  | { kind: 'skill'; label: string; detail: string }
  | { kind: 'command'; label: string; detail: string }

const props = defineProps<{
  modelValue: string
  placeholder: string
  disabled: boolean
  mcpEnabled: boolean
  resumes: ResumeVersion[]
  opportunities: Opportunity[]
  companies: Company[]
  industries: Industry[]
  dark: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  paste: [event: ClipboardEvent]
}>()
const { t } = useI18n()
const editor = ref<HTMLDivElement | null>(null)
const popup = ref<HTMLDivElement | null>(null)
const showPopup = ref(false)
const category = ref<Category | null>(null)
const trigger = ref<Trigger | null>(null)
const optionIndex = ref(0)
const popupStyle = ref({ left: '0px', top: '0px' })
let internalValue = ''
let composing = false
let dismissed = ''

const categoryLabels = computed<Record<Category, string>>(() => ({
  resume: t('agent.mentionResume'),
  opportunity: t('agent.mentionOpportunity'),
  company: t('agent.mentionCompany'),
  industry: t('agent.mentionIndustry'),
}))

const categoryOptions = computed<Option[]>(() =>
  (Object.keys(categoryLabels.value) as Category[]).map((item) => ({
    kind: 'category',
    category: item,
    label: categoryLabels.value[item],
    detail: '',
  })),
)

const referenceOptions = computed<Record<Category, Extract<Option, { kind: 'reference' }>[]>>(
  () => ({
    resume: props.resumes.map((item) => ({
      kind: 'reference',
      category: 'resume',
      id: item.id,
      label: item.name,
      detail: categoryLabels.value.resume,
      searchText: item.name,
    })),
    opportunity: props.opportunities.map((item) => ({
      kind: 'reference',
      category: 'opportunity',
      id: item.id,
      label: `${item.companyName} · ${item.title}`,
      detail: categoryLabels.value.opportunity,
      searchText: `${item.companyName} ${item.title}`,
    })),
    company: props.companies.map((item) => ({
      kind: 'reference',
      category: 'company',
      id: item.id,
      label: item.name,
      detail: categoryLabels.value.company,
      searchText: [item.name, ...item.aliases, item.industryName ?? ''].join(' '),
    })),
    industry: props.industries.map((item) => ({
      kind: 'reference',
      category: 'industry',
      id: item.id,
      label: item.name,
      detail: categoryLabels.value.industry,
      searchText: item.name,
    })),
  }),
)

const options = computed<Option[]>(() => {
  const active = trigger.value
  if (!active) return []
  const query = active.query.trim().toLocaleLowerCase()
  if (active.kind === 'skill')
    return [
      { kind: 'command', label: '/compact', detail: t('agent.compactDescription') } as const,
      ...(props.mcpEnabled
        ? [
            {
              kind: 'skill',
              label: '/resume-match',
              detail: t('agent.skillMatchDescription'),
            } as const,
          ]
        : []),
    ].filter((option) => option.label.toLocaleLowerCase().includes(query))
  if (!props.mcpEnabled) return []
  if (!category.value && !query) return categoryOptions.value
  const categories = category.value
    ? [category.value]
    : (Object.keys(referenceOptions.value) as Category[])
  return categories
    .flatMap((item) => referenceOptions.value[item])
    .filter((item) => item.searchText.toLocaleLowerCase().includes(query))
    .slice(0, 30)
})

function setCaret(node: Node, offset: number): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  editor.value?.focus()
}

function readParts(): AgentDraftPart[] {
  const root = editor.value
  if (!root) return []
  const parts: AgentDraftPart[] = []
  const appendText = (text: string): void => {
    if (!text) return
    const last = parts.at(-1)
    if (last?.kind === 'text') last.text += text
    else parts.push({ kind: 'text', text })
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? '')
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.agentReference) {
      parts.push(JSON.parse(node.dataset.agentReference) as AgentReference)
      return
    }
    if (node.tagName === 'BR') {
      appendText('\n')
      return
    }
    for (const child of Array.from(node.childNodes)) visit(child)
  }
  for (const child of Array.from(root.childNodes)) visit(child)
  return parts
}

function readValue(): string {
  return readParts()
    .map((part) => agentPartLabel(part, t))
    .join('')
}

defineExpose({ readParts })

function sync(): void {
  internalValue = readValue()
  emit('update:modelValue', internalValue)
  if (!composing) updateContext()
}

function closePopup(): void {
  showPopup.value = false
  trigger.value = null
  category.value = null
}

function positionPopup(): void {
  if (!showPopup.value || !editor.value) return
  const selection = window.getSelection()
  const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
  const fallback = editor.value.getBoundingClientRect()
  const width = Math.min(430, window.innerWidth - 24)
  const left = Math.max(
    12,
    Math.min(rect?.left ?? fallback.left + 12, window.innerWidth - width - 12),
  )
  const height = popup.value?.offsetHeight || 220
  const bottom = rect?.bottom || fallback.top + 28
  const top =
    bottom + height + 6 > window.innerHeight - 12
      ? Math.max(12, (rect?.top || fallback.top) - height - 6)
      : bottom + 6
  popupStyle.value = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
}

function updateContext(): void {
  const selection = window.getSelection()
  const root = editor.value
  if (
    !root ||
    !selection?.isCollapsed ||
    !selection.anchorNode ||
    !root.contains(selection.anchorNode)
  ) {
    closePopup()
    return
  }
  const node = selection.anchorNode
  if (node.nodeType !== Node.TEXT_NODE) {
    closePopup()
    return
  }
  const text = node.textContent ?? ''
  const before = text.slice(0, selection.anchorOffset)
  const slash = before.lastIndexOf('/')
  const slashQuery = slash >= 0 ? before.slice(slash + 1) : ''
  const slashActive =
    slash >= 0 && (slash === 0 || /\s/u.test(before[slash - 1])) && !/[\s\n@/]/u.test(slashQuery)
  const mention = before.lastIndexOf('@')
  const mentionQuery = mention >= 0 ? before.slice(mention + 1) : ''
  const mentionActive =
    mention >= 0 &&
    !mentionQuery.includes('\n') &&
    (mention === 0 || !/[A-Za-z0-9_]/u.test(before[mention - 1]))
  const kind = slashActive && slash > mention ? 'skill' : mentionActive ? 'mention' : null
  if (!kind || (kind === 'mention' && !props.mcpEnabled)) {
    closePopup()
    return
  }
  const start = kind === 'skill' ? slash : mention
  const query = kind === 'skill' ? slashQuery : mentionQuery
  if (trigger.value?.start !== start || trigger.value.kind !== kind) category.value = null
  const signature = `${kind}:${start}:${before.slice(start)}`
  if (dismissed === signature) return
  dismissed = ''
  const previous = trigger.value
  const unchanged =
    previous?.kind === kind &&
    previous.node === node &&
    previous.start === start &&
    previous.end === selection.anchorOffset &&
    previous.query === query
  trigger.value = { kind, node: node as Text, start, end: selection.anchorOffset, query }
  if (!unchanged) optionIndex.value = 0
  showPopup.value = true
  void nextTick(positionPopup)
}

function optionReference(
  option: Extract<Option, { kind: 'reference' | 'skill' | 'command' }>,
): AgentReference {
  if (option.kind === 'skill') return { kind: 'skill', name: 'resume-match' }
  if (option.kind === 'command') return { kind: 'command', name: 'compact' }
  return { kind: option.category, id: option.id, name: option.label }
}

function choose(option: Option): void {
  if (option.kind === 'category') {
    category.value = option.category
    optionIndex.value = 0
    editor.value?.focus()
    return
  }
  const active = trigger.value
  if (!active || !active.node.isConnected) return
  const reference = optionReference(option)
  const label = agentReferenceLabel(reference, t)
  const range = document.createRange()
  range.setStart(active.node, active.start)
  range.setEnd(active.node, active.end)
  range.deleteContents()
  const span = document.createElement('span')
  span.className = 'agent-reference'
  span.contentEditable = 'false'
  span.dataset.agentReference = JSON.stringify(reference)
  span.textContent = label
  span.title = label
  span.setAttribute('aria-label', label)
  range.insertNode(span)
  const previous = span.previousSibling
  if (
    (previous instanceof Text && previous.textContent && !/\s$/u.test(previous.textContent)) ||
    (previous instanceof HTMLElement && !!previous.dataset.agentReference)
  )
    span.before(document.createTextNode(' '))
  let following = span.nextSibling
  if (!(following instanceof Text) || !/^\s/u.test(following.textContent ?? '')) {
    following = document.createTextNode(' ')
    span.after(following)
    span.dataset.autoSeparator = 'true'
  }
  closePopup()
  dismissed = ''
  setCaret(following, 1)
  sync()
}

function back(): void {
  const active = trigger.value
  if (!active || active.kind !== 'mention') return
  const text = active.node.textContent ?? ''
  active.node.textContent = text.slice(0, active.start + 1) + text.slice(active.end)
  category.value = null
  optionIndex.value = 0
  setCaret(active.node, active.start + 1)
  sync()
}

function adjacentToken(direction: 'backward' | 'forward'): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.rangeCount || !editor.value) return null
  const range = selection.getRangeAt(0)
  const node = range.startContainer
  let candidate: Node | null = null
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? ''
    if (
      direction === 'backward' &&
      (range.startOffset === 0 || (range.startOffset === 1 && value.startsWith(' ')))
    )
      candidate = node.previousSibling
    if (direction === 'forward' && range.startOffset === value.length) candidate = node.nextSibling
  } else if (node === editor.value) {
    candidate =
      editor.value.childNodes[
        direction === 'backward' ? range.startOffset - 1 : range.startOffset
      ] || null
  }
  return candidate instanceof HTMLElement && candidate.dataset.agentReference ? candidate : null
}

function keydown(event: KeyboardEvent): void {
  if (composing || event.isComposing) return
  if (showPopup.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = options.value.length
      if (count)
        optionIndex.value =
          (optionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      void nextTick(() =>
        popup.value
          ?.querySelector<HTMLElement>('.agent-command-option.active')
          ?.scrollIntoView?.({ block: 'nearest' }),
      )
      return
    }
    if (
      ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') &&
      options.value[optionIndex.value]
    ) {
      event.preventDefault()
      choose(options.value[optionIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      const active = trigger.value
      dismissed = active
        ? `${active.kind}:${active.start}:${active.node.textContent?.slice(active.start, active.end)}`
        : ''
      closePopup()
      return
    }
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    const token = adjacentToken(event.key === 'Backspace' ? 'backward' : 'forward')
    if (token) {
      event.preventDefault()
      const next = token.nextSibling
      if (
        token.dataset.autoSeparator === 'true' &&
        next?.nodeType === Node.TEXT_NODE &&
        next.textContent?.startsWith(' ')
      )
        next.textContent = next.textContent.slice(1)
      token.remove()
      if (next?.isConnected && next.nodeType === Node.TEXT_NODE) setCaret(next, 0)
      sync()
      return
    }
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.shiftKey) insertText('\n')
    else emit('send')
  }
}

function insertText(value: string): void {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.value) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(value)
  range.insertNode(node)
  setCaret(node, value.length)
  sync()
}

function paste(event: ClipboardEvent): void {
  if ([...(event.clipboardData?.items ?? [])].some((item) => item.type.startsWith('image/'))) {
    emit('paste', event)
    return
  }
  event.preventDefault()
  insertText(event.clipboardData?.getData('text/plain')?.replace(/\r\n?/g, '\n') ?? '')
}

function compositionStart(): void {
  composing = true
}
function compositionEnd(): void {
  composing = false
  sync()
}

function outside(event: MouseEvent): void {
  if (popup.value?.contains(event.target as Node) || editor.value?.contains(event.target as Node))
    return
  closePopup()
}
function blur(): void {
  window.setTimeout(() => {
    if (!popup.value?.contains(document.activeElement)) closePopup()
  }, 120)
}

watch(
  () => props.modelValue,
  (value) => {
    if (value === internalValue) return
    // External updates clear the composer after a send. Editing never reparses user text as trusted tags.
    if (value !== '') return
    editor.value?.replaceChildren()
    internalValue = ''
    closePopup()
  },
)
watch([showPopup, options], () => void nextTick(positionPopup))
onMounted(() => {
  document.addEventListener('mousedown', outside, true)
  window.addEventListener('resize', positionPopup)
  window.addEventListener('scroll', positionPopup, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', outside, true)
  window.removeEventListener('resize', positionPopup)
  window.removeEventListener('scroll', positionPopup, true)
})
</script>

<template>
  <div class="agent-editor-wrapper">
    <div
      ref="editor"
      class="agent-editor"
      :contenteditable="!disabled"
      role="textbox"
      aria-multiline="true"
      :aria-label="placeholder"
      :data-placeholder="placeholder"
      :data-empty="!modelValue"
      :data-disabled="disabled"
      @input="sync"
      @keydown="keydown"
      @keyup="updateContext"
      @click="updateContext"
      @blur="blur"
      @scroll="positionPopup"
      @paste="paste"
      @drop.prevent
      @compositionstart="compositionStart"
      @compositionend="compositionEnd"
    />
    <Teleport to="body">
      <div
        v-if="showPopup"
        ref="popup"
        class="agent-command-popup"
        :class="{ dark }"
        :style="popupStyle"
        @mousedown.stop
      >
        <div class="agent-command-heading">
          <button v-if="category" type="button" @mousedown.prevent="back">
            ← {{ t('agent.menuBack') }}
          </button>
          <strong>{{
            trigger?.kind === 'skill'
              ? t('agent.slashTitle')
              : category
                ? categoryLabels[category]
                : t('agent.menuTitle')
          }}</strong>
        </div>
        <button
          v-for="(option, index) in options"
          :key="`${option.kind}-${option.label}-${index}`"
          type="button"
          class="agent-command-option"
          :class="{ active: optionIndex === index }"
          @mouseenter="optionIndex = index"
          @mousedown.prevent="choose(option)"
        >
          <strong>{{ option.label }}</strong>
          <small v-if="option.detail">{{ option.detail }}</small>
        </button>
        <div v-if="!options.length" class="agent-command-empty">{{ t('agent.menuEmpty') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.agent-editor-wrapper {
  min-width: 0;
}
.agent-editor {
  box-sizing: border-box;
  width: 100%;
  height: min(150px, 23vh);
  min-height: 64px;
  max-height: min(45vh, 320px);
  padding: 10px 12px;
  overflow: auto;
  resize: vertical;
  border: 1px solid #8886;
  border-radius: 4px;
  outline: none;
  background: var(--n-color, #fff);
  color: inherit;
  font: inherit;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-editor:focus {
  border-color: #5ba16a;
  box-shadow: 0 0 0 2px #5ba16a22;
}
.agent-editor[data-empty='true']::before {
  content: attr(data-placeholder);
  color: #888;
  pointer-events: none;
}
.agent-editor[data-disabled='true'] {
  opacity: 0.6;
  pointer-events: none;
}
:global(.agent-command-popup) {
  position: fixed;
  z-index: 10000;
  box-sizing: border-box;
  width: min(430px, calc(100vw - 24px));
  max-height: min(360px, calc(100vh - 24px));
  overflow: auto;
  padding: 6px;
  border: 1px solid #8884;
  border-radius: 8px;
  background: var(--n-color, #fff);
  box-shadow: 0 8px 24px #0002;
}
:global(.agent-command-popup.dark) {
  background: #1f1f1f;
  color: #eee;
  border-color: #555;
}
:global(.agent-command-popup.dark .agent-command-option:hover),
:global(.agent-command-popup.dark .agent-command-option.active) {
  background: #244833;
}
:global(.agent-command-heading) {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  color: #777;
}
:global(.agent-command-heading strong) {
  flex: 1;
}
:global(.agent-command-heading button) {
  border: 0;
  background: transparent;
  color: #4c9465;
  cursor: pointer;
}
:global(.agent-command-option) {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
:global(.agent-command-option:hover),
:global(.agent-command-option.active) {
  background: #eff8f2;
}
:global(.agent-command-option small),
:global(.agent-command-empty) {
  color: #888;
}
:global(.agent-command-empty) {
  padding: 14px 8px;
}
</style>
