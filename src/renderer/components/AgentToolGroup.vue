<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentMessage } from '../../shared/types'

defineProps<{
  tools: Extract<AgentMessage, { role: 'tool' }>[]
}>()
const { t } = useI18n()
const expanded = ref(true)
const statusKey = {
  running: 'agent.toolRunning',
  waiting: 'agent.toolWaiting',
  completed: 'agent.toolCompleted',
  error: 'agent.toolError',
} as const
</script>

<template>
  <div class="agent-tool-group">
    <button
      v-if="tools.length > 1"
      type="button"
      class="agent-tool-group-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      {{ t('agent.toolGroup', { count: tools.length }) }}
    </button>
    <div v-if="expanded" class="agent-tool-rows">
      <details v-for="tool in tools" :key="tool.id" class="agent-tool-row">
        <summary>
          <span class="agent-tool-icon" aria-hidden="true">⌘</span>
          <span class="agent-tool-name">{{ tool.name }}</span>
          <span class="agent-tool-state">{{ t(statusKey[tool.status]) }}</span>
        </summary>
        <div class="agent-tool-details">
          <template v-if="tool.args !== '{}'">
            <strong>{{ t('agent.toolInput') }}</strong>
            <pre>{{ tool.args }}</pre>
          </template>
          <template v-if="tool.result !== null">
            <strong>{{ t('agent.toolOutput') }}</strong>
            <pre>{{ tool.result }}</pre>
          </template>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.agent-tool-group {
  min-width: 0;
  color: #737983;
}
.agent-tool-group-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
  padding: 4px 2px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agent-tool-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-tool-row {
  min-width: 0;
}
.agent-tool-row summary {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
  cursor: pointer;
  list-style: none;
}
.agent-tool-row summary::-webkit-details-marker {
  display: none;
}
.agent-tool-row summary::after {
  content: '›';
  margin-left: auto;
  transition: transform 0.15s;
}
.agent-tool-row[open] summary::after {
  transform: rotate(90deg);
}
.agent-tool-icon {
  width: 22px;
  text-align: center;
}
.agent-tool-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.agent-tool-state {
  flex: none;
  font-size: 12px;
}
.agent-tool-details {
  padding: 8px 10px 10px 31px;
}
.agent-tool-details strong {
  font-size: 12px;
}
.agent-tool-details pre {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 4px 0 10px;
  font:
    12px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
</style>
