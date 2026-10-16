<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NCard, NModal, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AgentAttachment,
  AgentQueueItem,
  CompanySummary,
  Industry,
  Opportunity,
  ResumeVersion,
} from '../../shared/types'
import { useAgentStore } from '../stores/agent'
import AgentComposerEditor from './AgentComposerEditor.vue'
import AgentMessageBody from './AgentMessageBody.vue'
import { getErrorMessage } from '../utils/errors'
import { reportRendererFault } from '../diagnostics'

const props = defineProps<{
  conversationId: string
  mcpEnabled: boolean
  dark: boolean
  resumes: ResumeVersion[]
  opportunities: Opportunity[]
  companies: CompanySummary[]
  industries: Industry[]
}>()
const { t } = useI18n()
const store = useAgentStore()
const queue = computed(() => store.session(props.conversationId).queue)
const entries = computed(() => [
  ...queue.value.internal,
  ...queue.value.external,
  ...queue.value.failed,
])
const editing = ref<AgentQueueItem | null>(null)
const editor = ref<InstanceType<typeof AgentComposerEditor> | null>(null)
const text = ref('')
const files = ref<AgentAttachment[]>([])
const busy = ref(false)
const error = ref('')
const show = computed(() => !!editing.value)
let disposed = false

watch(queue, () => {
  if (editing.value && !entries.value.some((item) => item.id === editing.value!.id && item.editing))
    editing.value = null
})

async function action(item: AgentQueueItem, action: 'begin' | 'delete' | 'retry'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await store.editQueue(props.conversationId, { action, itemId: item.id })
    if (action === 'begin') {
      if (disposed) {
        await store.editQueue(props.conversationId, { action: 'cancel', itemId: item.id })
        return
      }
      if (!entries.value.some((entry) => entry.id === item.id && entry.editing)) return
      editing.value = item
      files.value = [...item.attachments]
      await nextTick()
      editor.value?.restoreParts(item.parts)
    }
    error.value = ''
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    busy.value = false
  }
}

async function close(): Promise<void> {
  if (!editing.value || busy.value) return
  try {
    await store.editQueue(props.conversationId, { action: 'cancel', itemId: editing.value.id })
    editing.value = null
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  }
}

async function save(): Promise<void> {
  if (!editing.value || busy.value) return
  busy.value = true
  try {
    await store.editQueue(props.conversationId, {
      action: 'save',
      itemId: editing.value.id,
      parts: editor.value?.readParts() ?? [],
      attachmentIds: files.value.map((file) => file.id),
    })
    editing.value = null
    error.value = ''
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    busy.value = false
  }
}

async function upload(): Promise<void> {
  if (busy.value || files.value.length >= 5) return
  busy.value = true
  try {
    const attachment = await window.zhijiApi.agent.upload(props.conversationId)
    if (attachment) files.value.push(attachment)
  } catch (cause) {
    error.value = getErrorMessage(cause, t)
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  if (editing.value)
    void store
      .editQueue(props.conversationId, { action: 'cancel', itemId: editing.value.id })
      .catch((cause) => reportRendererFault('agent.queue-release-edit', cause))
})
</script>

<template>
  <section
    v-if="entries.length || queue.blocked || error"
    class="agent-input-queue"
    :aria-label="t('agent.queueTitle')"
  >
    <div class="agent-queue-rows">
      <div
        v-for="(item, index) in entries"
        :key="item.id"
        class="agent-input-queue-row"
        :data-queue-id="item.id"
        :data-origin="item.origin"
      >
        <span class="agent-queue-order">{{
          item.origin === 'internal' ? t('agent.queueInternal') : index - queue.internal.length + 1
        }}</span>
        <div class="agent-queue-content">
          <AgentMessageBody :parts="item.parts" /><small v-if="item.attachments.length">{{
            item.attachments.map((file) => file.name).join(' · ')
          }}</small
          ><small v-if="queue.failed.includes(item)">{{ t('agent.queueFailed') }}</small
          ><small v-if="item.editing">{{ t('agent.queueEditing') }}</small>
        </div>
        <n-space v-if="item.origin === 'external'" :size="4" :wrap="false">
          <n-button size="tiny" :disabled="busy || item.editing" @click="action(item, 'begin')">{{
            t('agent.queueEdit')
          }}</n-button>
          <n-button
            v-if="queue.failed.includes(item)"
            size="tiny"
            :disabled="busy || queue.external.length >= 3"
            @click="action(item, 'retry')"
            >{{ t('agent.queueRetry') }}</n-button
          >
          <n-button size="tiny" :disabled="busy || item.editing" @click="action(item, 'delete')">{{
            t('agent.queueDelete')
          }}</n-button>
        </n-space>
      </div>
    </div>
    <div v-if="queue.blocked">{{ t('agent.sendUnverified') }}</div>
    <div v-if="error" role="alert">{{ error }}</div>
  </section>
  <n-modal :show="show" :mask-closable="!busy" @update:show="!$event && close()">
    <n-card
      class="agent-queue-editor-modal"
      :title="t('agent.queueEdit')"
      role="dialog"
      aria-modal="true"
      closable
      @close="close"
    >
      <AgentComposerEditor
        ref="editor"
        v-model="text"
        :disabled="busy"
        :placeholder="t('agent.messagePlaceholder')"
        :mcp-enabled="mcpEnabled"
        :dark="dark"
        :resumes="resumes"
        :opportunities="opportunities"
        :companies="companies"
        :industries="industries"
        @send="save"
      />
      <div class="agent-queue-edit-files">
        <span v-for="file in files" :key="file.id"
          >{{ file.name
          }}<n-button
            size="tiny"
            :disabled="busy"
            :aria-label="t('agent.removeAttachment', { name: file.name })"
            @click="files = files.filter((item) => item.id !== file.id)"
            >×</n-button
          ></span
        >
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <template #footer
        ><n-space justify="end"
          ><n-button
            :disabled="busy || files.length >= 5 || editing?.operation === 'compact'"
            @click="upload"
            >{{ t('agent.upload') }}</n-button
          ><n-button :disabled="busy" @click="close">{{ t('agent.queueCancelEdit') }}</n-button
          ><n-button
            type="primary"
            :disabled="busy || text.length > 30000 || (!text.trim() && !files.length)"
            @click="save"
            >{{ t('agent.queueSave') }}</n-button
          ></n-space
        ></template
      >
    </n-card>
  </n-modal>
</template>

<style scoped>
.agent-input-queue {
  flex-shrink: 0;
  margin: 0 12px 6px;
  border: 1px solid var(--border-color, #8884);
  border-radius: 8px;
  padding: 8px;
  font-size: 12px;
}
.agent-queue-rows {
  max-height: 150px;
  overflow: auto;
}
.agent-input-queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.agent-queue-order {
  flex-shrink: 0;
  opacity: 0.65;
}
.agent-queue-content {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 64px;
  overflow: auto;
}
.agent-queue-content small {
  display: block;
  opacity: 0.65;
}
.agent-queue-editor-modal {
  width: min(680px, 94vw);
  max-height: 90vh;
  overflow: auto;
}
.agent-queue-edit-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
