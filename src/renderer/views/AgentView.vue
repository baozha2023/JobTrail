<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NDropdown, NInput, NModal, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AgentAttachment,
  AgentConversation,
  AgentMessage,
  AgentPending,
  AgentUsage,
  Company,
  Industry,
  Opportunity,
  ResumeVersion,
} from '../../shared/types'
import { getErrorMessage } from '../utils/errors'
import AgentComposerEditor from '../components/AgentComposerEditor.vue'
import AgentMarkdown from '../components/AgentMarkdown.vue'
import AgentMessageBody from '../components/AgentMessageBody.vue'
import AgentToolGroup from '../components/AgentToolGroup.vue'

type ToolMessage = Extract<AgentMessage, { role: 'tool' }>
type TimelineEntry =
  | Exclude<AgentMessage, { role: 'tool' }>
  | { id: string; role: 'tool-group'; tools: ToolMessage[] }

const props = defineProps<{
  mcpEnabled: boolean
  multimodal: boolean
  resumes: ResumeVersion[]
  opportunities: Opportunity[]
  companies: Company[]
  industries: Industry[]
  dark: boolean
}>()
const { t } = useI18n()
const conversations = ref<AgentConversation[]>([])
const currentId = ref<string | null>(null)
const messages = ref<AgentMessage[]>([])
const usage = ref<AgentUsage | null>(null)
const messagePane = ref<HTMLElement | null>(null)
const pending = ref<AgentPending | null>(null)
const draft = ref('')
const composer = ref<InstanceType<typeof AgentComposerEditor> | null>(null)
const answerSelection = ref<(number | null)[]>([])
const answerText = ref<string[]>([])
const questionStep = ref(0)
const uploads = ref<AgentAttachment[]>([])
const busy = ref(false)
const uploading = ref(false)
const error = ref('')
const previews = ref<Record<string, string>>({})
const historyMenu = ref<{ id: string; x: number; y: number } | null>(null)
let optimisticSequence = 0
const deleteTargetId = ref<string | null>(null)
const renameTargetId = ref<string | null>(null)
const renameDraft = ref('')
const renameSaving = ref(false)
const activeConversation = computed(() =>
  conversations.value.find((conversation) => conversation.id === currentId.value),
)
const historyMenuOptions = computed(() => [
  { label: t('agent.rename'), key: 'rename' },
  { label: t('agent.delete'), key: 'delete' },
])
const timeline = computed<TimelineEntry[]>(() => {
  const entries: TimelineEntry[] = []
  for (const message of messages.value) {
    if (message.role !== 'tool') {
      entries.push(message)
      continue
    }
    const previous = entries.at(-1)
    if (previous?.role === 'tool-group') previous.tools.push(message)
    else entries.push({ id: `group:${message.id}`, role: 'tool-group', tools: [message] })
  }
  return entries
})
const contextPercent = computed(() =>
  usage.value?.contextTokens === null || !usage.value
    ? 0
    : Math.min(
        100,
        Math.round((100 * usage.value.contextTokens) / usage.value.contextWindowTokens),
      ),
)
const contextTitle = computed(() =>
  t(usage.value?.contextEstimated ? 'agent.contextUsedEstimated' : 'agent.contextUsed', {
    percent: contextPercent.value,
  }),
)
const questionAnswers = computed(() =>
  pending.value?.kind === 'question'
    ? pending.value.questions.map((question, index) => {
        if (!question.options) return answerText.value[index]?.trim() ?? ''
        const selection = answerSelection.value[index]
        if (selection === null || selection === undefined) return ''
        return selection >= 0
          ? (question.options[selection]?.label ?? '')
          : (answerText.value[index]?.trim() ?? '')
      })
    : [],
)
const canReply = computed(
  () => questionAnswers.value.length > 0 && questionAnswers.value.every((value) => !!value),
)
const activeQuestion = computed(() =>
  pending.value?.kind === 'question' ? pending.value.questions[questionStep.value] : null,
)
const canAdvanceQuestion = computed(() => !!questionAnswers.value[questionStep.value])
function moveQuestion(step: number): void {
  questionStep.value = step
}
function advanceQuestion(): void {
  if (pending.value?.kind !== 'question' || !canAdvanceQuestion.value || busy.value) return
  if (questionStep.value < pending.value.questions.length - 1) moveQuestion(questionStep.value + 1)
  else void respond(questionAnswers.value)
}
function showPending(value: AgentPending | null): void {
  pending.value = value
  questionStep.value = 0
  answerSelection.value =
    value?.kind === 'question'
      ? value.questions.map((question) => {
          const recommended = question.options?.findIndex((option) => option.recommended)
          return recommended !== undefined && recommended >= 0 ? recommended : null
        })
      : []
  answerText.value = value?.kind === 'question' ? value.questions.map(() => '') : []
}
function formatK(tokens: number | null | undefined): string {
  return tokens === null || tokens === undefined
    ? t('agent.usageUnavailable')
    : `${(tokens / 1000).toFixed(1)}k`
}
function lastTool(predicate: (message: ToolMessage) => boolean): ToolMessage | undefined {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]
    if (message.role === 'tool' && predicate(message)) return message
  }
  return undefined
}
const thinking = computed(() => {
  if (!busy.value || pending.value) return false
  const last = messages.value.at(-1)
  if (!last || last.role === 'user') return true
  if (last.role !== 'tool') return false
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]
    if (message.role !== 'tool') break
    if (message.status === 'running' || message.status === 'waiting') return false
  }
  return true
})
watch(
  () => {
    const last = messages.value.at(-1)
    return [messages.value.length, last?.role === 'assistant' ? last.text : '']
  },
  async () => {
    await nextTick()
    if (messagePane.value) messagePane.value.scrollTop = messagePane.value.scrollHeight
  },
)
function showHistoryMenu(event: MouseEvent, id: string): void {
  if (busy.value || uploading.value) return
  historyMenu.value = { id, x: event.clientX, y: event.clientY }
}
function chooseHistoryMenu(key: string): void {
  const id = historyMenu.value?.id
  historyMenu.value = null
  if (key === 'delete' && id) deleteTargetId.value = id
  if (key === 'rename' && id) {
    renameTargetId.value = id
    renameDraft.value = conversations.value.find((item) => item.id === id)?.title ?? ''
  }
}
async function confirmRename(): Promise<void> {
  const id = renameTargetId.value
  if (!id || renameSaving.value) return
  renameSaving.value = true
  try {
    await window.zhijiApi.agent.rename(id, renameDraft.value)
    await refreshList()
    renameTargetId.value = null
    error.value = ''
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    renameSaving.value = false
  }
}
async function confirmDelete(): Promise<void> {
  const id = deleteTargetId.value
  deleteTargetId.value = null
  if (id) await removeConversation(id)
}

async function loadPreview(attachment: AgentAttachment, id: string): Promise<void> {
  if (!attachment.mimeType.startsWith('image/')) return
  try {
    const url = await window.zhijiApi.agent.preview(id, attachment.id)
    if (url && currentId.value === id) previews.value[attachment.id] = url
  } catch (cause) {
    console.error('加载聊天附件预览失败', cause)
  }
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  const images = [...(event.clipboardData?.items ?? [])]
    .filter((item) => ['image/png', 'image/jpeg', 'image/webp'].includes(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (!images.length) return
  event.preventDefault()
  if (!props.multimodal) {
    error.value = t('agent.pasteImageDisabled')
    return
  }
  if (uploads.value.length + images.length > 5) {
    error.value = t('agent.tooManyAttachments')
    return
  }
  if (images.some((file) => file.size > 5 * 1024 * 1024)) {
    error.value = t('agent.imageTooLarge')
    return
  }
  if (uploading.value) return
  uploading.value = true
  try {
    const id = currentId.value ?? (await createConversation())
    for (const [index, file] of images.entries()) {
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]
      const name = `clipboard-${Date.now()}-${index}.${extension}`
      const attachment = await window.zhijiApi.agent.uploadBytes(
        id,
        name,
        file.type,
        new Uint8Array(await file.arrayBuffer()),
      )
      uploads.value.push(attachment)
      await loadPreview(attachment, id)
    }
    error.value = ''
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    uploading.value = false
  }
}

async function discardUploads(id: string, attachments: AgentAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    try {
      await window.zhijiApi.agent.removeUpload(id, attachment.id)
    } catch (cause) {
      console.error('清理未发送附件失败', cause)
    }
  }
}

async function refreshList(): Promise<void> {
  conversations.value = await window.zhijiApi.agent.list()
}
async function selectConversation(id: string): Promise<void> {
  if (currentId.value && currentId.value !== id && uploads.value.length)
    await discardUploads(currentId.value, uploads.value)
  currentId.value = id
  uploads.value = []
  previews.value = {}
  const history = await window.zhijiApi.agent.history(id)
  if (currentId.value !== id) return
  messages.value = history.messages
  showPending(history.pending)
  usage.value = history.usage
  busy.value = history.running
  for (const attachment of history.messages.flatMap((message) => message.attachments))
    void loadPreview(attachment, id)
}
async function createConversation(): Promise<string> {
  const conversation = await window.zhijiApi.agent.create()
  await refreshList()
  await selectConversation(conversation.id)
  return conversation.id
}
async function removeConversation(id: string): Promise<void> {
  try {
    await window.zhijiApi.agent.delete(id)
    await refreshList()
    if (currentId.value === id) {
      currentId.value = null
      messages.value = []
      showPending(null)
      usage.value = null
    }
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  }
}
async function upload(): Promise<void> {
  if (uploading.value) return
  uploading.value = true
  try {
    if (uploads.value.length >= 5) {
      error.value = t('agent.tooManyAttachments')
      return
    }
    const id = currentId.value ?? (await createConversation())
    const attachment = await window.zhijiApi.agent.upload(id)
    if (attachment) {
      uploads.value.push(attachment)
      await loadPreview(attachment, id)
    }
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    uploading.value = false
  }
}
async function removeAttachment(attachment: AgentAttachment): Promise<void> {
  if (!currentId.value || uploading.value) return
  try {
    await window.zhijiApi.agent.removeUpload(currentId.value, attachment.id)
    uploads.value = uploads.value.filter((item) => item.id !== attachment.id)
    delete previews.value[attachment.id]
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  }
}
async function send(): Promise<void> {
  if (busy.value || uploading.value || pending.value) return
  if (draft.value.length > 30_000) {
    error.value = t('agent.messageTooLong')
    return
  }
  let submitted: { id: string; previousCount: number; optimisticId: string } | null = null
  try {
    const id = currentId.value ?? (await createConversation())
    const parts = composer.value?.readParts() ?? []
    const command = parts.some((part) => part.kind === 'command')
    const typedCompact =
      parts.length === 1 && parts[0].kind === 'text' && parts[0].text.trim() === '/compact'
    const selectedCompact =
      parts.filter((part) => part.kind === 'command').length === 1 &&
      parts.every((part) => part.kind === 'command' || (part.kind === 'text' && !part.text.trim()))
    if (command || typedCompact) {
      if (uploads.value.length || !(typedCompact || selectedCompact)) {
        error.value = t('agent.compactOnly')
        return
      }
      busy.value = true
      error.value = ''
      await window.zhijiApi.agent.compact(id)
      draft.value = ''
      await selectConversation(id)
      return
    }
    if (!draft.value.trim() && !uploads.value.length) return
    busy.value = true
    error.value = ''
    const attachmentIds = uploads.value.map((item) => item.id)
    const optimisticId = `optimistic-${++optimisticSequence}`
    submitted = { id, previousCount: messages.value.length, optimisticId }
    messages.value = [
      ...messages.value,
      { id: optimisticId, role: 'user', parts, attachments: [...uploads.value] },
    ]
    await nextTick()
    await window.zhijiApi.agent.send(id, parts, attachmentIds)
    draft.value = ''
    uploads.value = []
    await selectConversation(id)
    await refreshList()
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
    const request = submitted
    if (request) {
      try {
        const history = await window.zhijiApi.agent.history(request.id)
        if (history.messages.slice(request.previousCount).some((item) => item.role === 'user')) {
          draft.value = ''
          uploads.value = []
          await selectConversation(request.id)
          await refreshList()
        } else {
          messages.value = messages.value.filter((item) => item.id !== request.optimisticId)
        }
      } catch (historyError) {
        messages.value = messages.value.filter((item) => item.id !== request.optimisticId)
        console.error('检查已发送消息失败', historyError)
      }
    }
  } finally {
    busy.value = false
  }
}
async function respond(value: string[] | boolean): Promise<void> {
  if (!currentId.value || !pending.value || busy.value) return
  if (pending.value.kind === 'question' && !canReply.value) return
  const id = currentId.value
  const request = pending.value
  busy.value = true
  pending.value = null
  error.value = ''
  const waiting = lastTool((message) => message.status === 'waiting')
  if (waiting) waiting.status = 'running'
  try {
    await window.zhijiApi.agent.resume(id, value)
    await selectConversation(id)
  } catch (cause) {
    if (currentId.value === id && !pending.value) pending.value = request
    if (waiting?.status === 'running') waiting.status = 'waiting'
    error.value = getErrorMessage(cause, t)
  } finally {
    busy.value = false
  }
}
async function cancel(): Promise<void> {
  if (currentId.value) await window.zhijiApi.agent.cancel(currentId.value)
}

let unsubscribe: (() => void) | undefined
onMounted(async () => {
  unsubscribe = window.zhijiApi.agent.onEvent((event) => {
    if (event.conversationId !== currentId.value) return
    if (event.kind === 'title') {
      const current = conversations.value.find((item) => item.id === event.conversationId)
      if (current && event.text) current.title = event.text
    } else if (event.kind === 'token' && event.text) {
      const last = messages.value.at(-1)
      if (last?.role === 'assistant' && last.id.startsWith('live:')) last.text += event.text
      else
        messages.value.push({
          id: `live:${++optimisticSequence}`,
          role: 'assistant',
          text: event.text,
          attachments: [],
        })
    } else if (event.kind === 'tool-start' && event.toolCallId) {
      messages.value.push({
        id: `tool:${event.toolCallId}`,
        role: 'tool',
        toolCallId: event.toolCallId,
        name: event.toolName ?? '',
        args: event.toolArgs ?? '{}',
        result: null,
        status: 'running',
        attachments: [],
      })
    } else if (event.kind === 'tool-end' && event.toolCallId) {
      const call = lastTool((item) => item.toolCallId === event.toolCallId)
      if (call) {
        call.status = event.toolStatus ?? 'completed'
        call.result = event.toolResult ?? ''
      }
    } else if (event.kind === 'pending') {
      showPending(event.pending ?? null)
      const waiting = messages.value.find(
        (message) => message.role === 'tool' && message.status === 'running',
      )
      if (waiting?.role === 'tool') waiting.status = 'waiting'
    } else if (event.kind === 'compact' && event.compact) {
      messages.value.push(event.compact)
    } else if (event.kind === 'usage' && event.usage) {
      usage.value = event.usage
    } else if (event.kind === 'done') {
      busy.value = false
    } else if (event.kind === 'error') {
      busy.value = false
      error.value = event.text ?? ''
    }
  })
  try {
    await refreshList()
    if (conversations.value[0]) await selectConversation(conversations.value[0].id)
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  }
})
onBeforeUnmount(() => {
  unsubscribe?.()
  if (currentId.value && uploads.value.length) void discardUploads(currentId.value, uploads.value)
})
</script>

<template>
  <div class="agent-layout" :class="{ dark }">
    <main class="agent-main">
      <div class="agent-intro">
        <strong>{{ activeConversation?.title ?? t('agent.newChat') }}</strong>
      </div>
      <div ref="messagePane" class="agent-messages" aria-live="polite">
        <div v-if="!timeline.length" class="agent-empty">{{ t('agent.empty') }}</div>
        <template v-for="entry in timeline" :key="entry.id">
          <AgentToolGroup v-if="entry.role === 'tool-group'" :tools="entry.tools" />
          <details v-else-if="entry.role === 'compact'" class="agent-compact-row">
            <summary>
              {{ t(entry.status === 'completed' ? 'agent.compactDone' : 'agent.compactSkipped') }}
            </summary>
            <span>{{
              t('agent.compactBeforeAfter', {
                before: formatK(entry.beforeTokens),
                after: formatK(entry.afterTokens),
              })
            }}</span>
          </details>
          <article v-else class="agent-message" :class="entry.role">
            <p v-if="entry.role === 'user'"><AgentMessageBody :parts="entry.parts" /></p>
            <div v-else>
              <AgentMarkdown :text="entry.text" /><small v-if="entry.incomplete">{{
                t('agent.incomplete')
              }}</small>
            </div>
            <div v-if="entry.attachments.length" class="agent-attachments">
              <div
                v-for="attachment in entry.attachments"
                :key="attachment.id"
                class="agent-attachment-card"
                :title="attachment.name"
              >
                <img
                  v-if="previews[attachment.id]"
                  :src="previews[attachment.id]"
                  :alt="attachment.name"
                />
                <span v-else class="agent-file-icon">{{
                  attachment.name.split('.').at(-1)?.toUpperCase()
                }}</span>
                <small>{{ attachment.name }}</small>
              </div>
            </div>
          </article>
        </template>
        <p v-if="thinking" class="agent-thinking">{{ t('agent.thinking') }}</p>
      </div>
      <div v-if="error" class="agent-error" role="alert">{{ error }}</div>
      <div v-if="pending" class="agent-pending">
        <div class="agent-pending-heading">
          <strong>{{
            t(
              pending.kind === 'confirmation'
                ? 'agent.pendingConfirmation'
                : 'agent.pendingQuestion',
            )
          }}</strong>
          <span v-if="pending.kind === 'question'">{{
            t('agent.questionProgress', {
              current: questionStep + 1,
              total: pending.questions.length,
            })
          }}</span>
        </div>
        <pre v-if="pending.kind === 'confirmation'">{{ pending.message }}</pre>
        <template v-if="pending.kind === 'confirmation'">
          <n-space
            ><n-button type="primary" :disabled="busy" @click="respond(true)">{{
              t('agent.approve')
            }}</n-button
            ><n-button :disabled="busy" @click="respond(false)">{{
              t('agent.cancel')
            }}</n-button></n-space
          >
        </template>
        <template v-else>
          <div v-if="activeQuestion" class="agent-question">
            <strong>{{ activeQuestion.question }}</strong>
            <div v-if="activeQuestion.options" class="agent-question-options">
              <label
                v-for="(option, optionIndex) in activeQuestion.options"
                :key="optionIndex"
                class="agent-question-option"
                :class="{ selected: answerSelection[questionStep] === optionIndex }"
              >
                <input
                  type="radio"
                  :name="`question-${questionStep}`"
                  :checked="answerSelection[questionStep] === optionIndex"
                  @change="answerSelection[questionStep] = optionIndex"
                />
                <span>
                  <span class="agent-question-label"
                    >{{ option.label }}
                    <small v-if="option.recommended">{{ t('agent.recommended') }}</small></span
                  >
                  <small>{{ option.description }}</small>
                </span>
              </label>
              <label
                class="agent-question-option"
                :class="{ selected: answerSelection[questionStep] === -1 }"
              >
                <input
                  type="radio"
                  :name="`question-${questionStep}`"
                  :checked="answerSelection[questionStep] === -1"
                  @change="answerSelection[questionStep] = -1"
                />
                <span class="agent-question-label">{{ t('agent.otherAnswer') }}</span>
              </label>
            </div>
            <n-input
              v-if="!activeQuestion.options || answerSelection[questionStep] === -1"
              v-model:value="answerText[questionStep]"
              type="textarea"
              :autosize="{ minRows: 2 }"
              :maxlength="10000"
              :placeholder="t('agent.answerPlaceholder')"
            />
          </div>
          <div class="agent-pending-actions">
            <n-button
              v-if="questionStep > 0"
              class="agent-question-back"
              :disabled="busy"
              @click="moveQuestion(questionStep - 1)"
              >{{ t('agent.previousQuestion') }}</n-button
            >
            <n-button
              class="agent-question-next"
              type="primary"
              :disabled="busy || !canAdvanceQuestion"
              @click="advanceQuestion"
              >{{
                t(
                  questionStep === pending.questions.length - 1
                    ? 'agent.submitAnswers'
                    : 'agent.nextQuestion',
                )
              }}</n-button
            >
          </div>
        </template>
      </div>
      <div v-else class="agent-composer">
        <div v-if="uploads.length" class="agent-attachments agent-compose-attachments">
          <div
            v-for="attachment in uploads"
            :key="attachment.id"
            class="agent-attachment-card"
            :title="attachment.name"
          >
            <img
              v-if="previews[attachment.id]"
              :src="previews[attachment.id]"
              :alt="attachment.name"
            />
            <span v-else class="agent-file-icon">{{
              attachment.name.split('.').at(-1)?.toUpperCase()
            }}</span>
            <small>{{ attachment.name }}</small>
            <button
              type="button"
              class="agent-attachment-remove"
              :aria-label="t('agent.removeAttachment', { name: attachment.name })"
              @click="removeAttachment(attachment)"
            >
              ×
            </button>
          </div>
        </div>
        <AgentComposerEditor
          ref="composer"
          v-model="draft"
          :placeholder="t('agent.messagePlaceholder')"
          :disabled="busy"
          :mcp-enabled="mcpEnabled"
          :resumes="resumes"
          :opportunities="opportunities"
          :companies="companies"
          :industries="industries"
          :dark="dark"
          @send="send"
          @paste="onPaste"
        />
        <div class="agent-actions">
          <div class="agent-usage" v-if="usage">
            <div class="agent-context-ring" :title="contextTitle">
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle class="agent-ring-track" cx="18" cy="18" r="15" />
                <circle
                  class="agent-ring-fill"
                  cx="18"
                  cy="18"
                  r="15"
                  pathLength="100"
                  :stroke-dasharray="`${contextPercent} 100`"
                />
              </svg>
            </div>
            <span :title="contextTitle">{{ contextPercent }}%</span>
            <span>{{ t('agent.usageInput') }} {{ formatK(usage.inputTokens) }}</span>
            <span>{{ t('agent.usageOutput') }} {{ formatK(usage.outputTokens) }}</span>
            <span>{{ t('agent.usageCached') }} {{ formatK(usage.cacheReadTokens) }}</span>
          </div>
          <n-space>
            <n-button :disabled="busy || uploading" @click="upload">{{
              t('agent.upload')
            }}</n-button>
            <n-button v-if="busy" @click="cancel">{{ t('agent.stop') }}</n-button>
            <n-button
              v-else
              type="primary"
              :disabled="uploading || draft.length > 30000 || (!draft.trim() && !uploads.length)"
              @click="send"
              >{{ t('agent.send') }}</n-button
            >
          </n-space>
        </div>
      </div>
    </main>
    <aside class="agent-history">
      <div class="agent-history-header">
        <strong>{{ t('agent.history') }}</strong
        ><n-button
          size="small"
          type="primary"
          :disabled="busy || uploading"
          @click="createConversation"
          >{{ t('agent.newChat') }}</n-button
        >
      </div>
      <div v-if="!conversations.length" class="agent-empty">{{ t('agent.noChats') }}</div>
      <div
        v-for="conversation in conversations"
        :key="conversation.id"
        class="agent-history-row"
        :class="{ active: currentId === conversation.id }"
        @contextmenu.prevent="showHistoryMenu($event, conversation.id)"
      >
        <button
          type="button"
          :disabled="busy || uploading"
          @click="selectConversation(conversation.id)"
        >
          {{ conversation.title }}
        </button>
      </div>
      <n-dropdown
        :show="!!historyMenu"
        trigger="manual"
        placement="bottom-start"
        :x="historyMenu?.x"
        :y="historyMenu?.y"
        :options="historyMenuOptions"
        @select="chooseHistoryMenu"
        @clickoutside="historyMenu = null"
      >
        <span class="agent-history-menu-anchor" aria-hidden="true"></span>
      </n-dropdown>
    </aside>
    <n-modal
      :show="!!renameTargetId"
      @update:show="renameTargetId = $event ? renameTargetId : null"
    >
      <n-card
        :title="t('agent.rename')"
        style="width: min(420px, 90vw)"
        closable
        @close="renameTargetId = null"
      >
        <n-input
          v-model:value="renameDraft"
          :maxlength="100"
          :placeholder="t('agent.renamePlaceholder')"
          @keydown.enter.exact.prevent="confirmRename"
        />
        <template #footer>
          <n-space justify="end">
            <n-button @click="renameTargetId = null">{{ t('agent.cancel') }}</n-button>
            <n-button
              type="primary"
              :loading="renameSaving"
              :disabled="!renameDraft.trim()"
              @click="confirmRename"
              >{{ t('agent.saveTitle') }}</n-button
            >
          </n-space>
        </template>
      </n-card>
    </n-modal>
    <n-modal
      :show="!!deleteTargetId"
      @update:show="deleteTargetId = $event ? deleteTargetId : null"
    >
      <n-card
        :title="t('agent.delete')"
        style="width: min(420px, 90vw)"
        closable
        @close="deleteTargetId = null"
      >
        <p>{{ t('agent.deleteConfirm') }}</p>
        <n-space justify="end">
          <n-button @click="deleteTargetId = null">{{ t('agent.cancel') }}</n-button>
          <n-button type="error" @click="confirmDelete">{{ t('agent.delete') }}</n-button>
        </n-space>
      </n-card>
    </n-modal>
  </div>
</template>

<style scoped>
.agent-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(180px, 22vw, 260px);
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 0;
  gap: 8px;
  overflow: hidden;
}
.agent-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--n-border-color, #ddd);
  border-radius: 14px;
  background: var(--n-color, #fff);
}
.agent-intro {
  padding: 10px 12px;
  border-bottom: 1px solid #8883;
}
.agent-messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.agent-empty {
  color: #888;
  padding: 20px;
  text-align: center;
}
.agent-message {
  max-width: 84%;
  padding: 12px 16px;
  border-radius: 12px;
  background: #f1f3f6;
  overflow-wrap: anywhere;
}
.agent-message.user {
  align-self: flex-end;
  background: #eeebfb;
  white-space: pre-wrap;
}
.agent-message.assistant {
  align-self: flex-start;
}
.agent-message p {
  margin: 0;
  line-height: 1.6;
}
.agent-attachments {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.agent-attachment-card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 132px;
  height: 118px;
  overflow: hidden;
  border: 1px solid #8884;
  border-radius: 12px;
  background: var(--n-color, #fff);
}
.agent-attachment-card img,
.agent-file-icon {
  width: 100%;
  height: 88px;
  object-fit: cover;
}
.agent-file-icon {
  display: grid;
  place-items: center;
  color: #7865d6;
  font-size: 18px;
  font-weight: 700;
  background: #7865d612;
}
.agent-attachment-card small {
  overflow: hidden;
  padding: 5px 8px;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.agent-attachment-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 50%;
  background: #20222bcc;
  color: #fff;
  cursor: pointer;
}
.agent-thinking {
  color: #888;
  font-size: 12px;
}
.agent-error {
  margin: 0 16px 8px;
  color: #d03050;
}
.agent-pending {
  flex: 0 0 auto;
  margin: 8px 10px;
  padding: 14px;
  border: 1px solid #d8ab51;
  border-radius: 10px;
  display: grid;
  gap: 10px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-pending-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.agent-pending-heading span {
  color: #888;
  white-space: nowrap;
}
.agent-pending pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  font: inherit;
}
.agent-question {
  display: grid;
  gap: 8px;
}
.agent-question-options {
  display: grid;
  gap: 6px;
}
.agent-question-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid #8884;
  border-radius: 9px;
  cursor: pointer;
}
.agent-question-option.selected {
  border-color: #5a9a6d;
  background: #5a9a6d18;
}
.agent-question-option input {
  margin-top: 4px;
  accent-color: #4b8e60;
}
.agent-question-option > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}
.agent-question-option small {
  color: #888;
}
.agent-question-label small {
  margin-left: 8px;
  color: #4b8e60;
}
.agent-pending-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.agent-composer {
  position: relative;
  flex: 0 1 auto;
  min-height: 0;
  max-height: 58%;
  overflow: auto;
  padding: 8px 10px;
  border-top: 1px solid #8883;
}
.agent-compose-attachments {
  margin: 0 0 10px;
}
.agent-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.agent-usage {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-right: auto;
  color: #777;
  font-size: 11px;
  white-space: nowrap;
}
.agent-context-ring {
  width: 19px;
  height: 19px;
  flex: none;
}
.agent-context-ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.agent-context-ring circle {
  fill: none;
  stroke-width: 4;
}
.agent-ring-track {
  stroke: #d9dde1;
}
.agent-ring-fill {
  stroke: #5ba16a;
  stroke-linecap: round;
}
.agent-compact-row {
  align-self: flex-start;
  color: #737983;
  font-size: 13px;
}
.agent-compact-row summary {
  cursor: pointer;
}
.agent-compact-row span {
  display: block;
  padding: 4px 0 0 16px;
}
@media (max-width: 760px) {
  .agent-usage {
    flex-wrap: wrap;
    white-space: normal;
  }
}
.agent-history {
  overflow: auto;
  min-height: 0;
  border: 1px solid #8883;
  border-radius: 14px;
  padding: 8px;
}
.agent-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.agent-history-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding: 4px;
}
.agent-history-row.active {
  background: #7865d622;
}
.agent-history-row button {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 8px;
}
.agent-history-menu-anchor {
  position: absolute;
  width: 0;
  height: 0;
}
.agent-layout.dark .agent-main,
.agent-layout.dark .agent-history {
  background: #1f1f1f;
  color: #eee;
}
.agent-layout.dark .agent-message {
  background: #30333b;
}
.agent-layout.dark .agent-message.user {
  background: #39334d;
}
.agent-layout.dark :deep(.agent-editor) {
  background: #1f1f1f;
  color: #eee;
}
@media (max-width: 900px) {
  .agent-layout {
    grid-template-columns: minmax(0, 1fr) 180px;
  }
}
</style>
