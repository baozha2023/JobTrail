<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NCard, NModal, NSelect, NSpin } from 'naive-ui'
import type { Opportunity, OpportunityStatusFlow, StatusFlowTheme } from '../../shared/types'

const props = defineProps<{
  show: boolean
  opportunity: Opportunity | null
  flow: OpportunityStatusFlow | null
  loading: boolean
  theme: StatusFlowTheme
  themeSaving: boolean
  dark: boolean
  locale: string
}>()
const emit = defineEmits<{
  close: []
  selectTheme: [value: StatusFlowTheme]
}>()
const { t } = useI18n()

const themeOptions = computed(() => [
  { label: t('opportunity.flowThemeViolet'), value: 'violet' },
  { label: t('opportunity.flowThemeOcean'), value: 'ocean' },
  { label: t('opportunity.flowThemeGold'), value: 'gold' },
])
const heading = computed(() => {
  const opportunity = props.flow?.opportunity ?? props.opportunity
  return opportunity ? `${opportunity.companyName} - ${opportunity.title}` : ''
})

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(props.locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

function onShowChange(value: boolean): void {
  if (!value) emit('close')
}
</script>

<template>
  <n-modal :show="show" @update:show="onShowChange">
    <n-card
      class="status-flow-modal"
      :class="{ 'is-dark': dark }"
      :data-flow-theme="theme"
      :aria-label="heading || t('opportunity.flowTitle')"
      :bordered="false"
    >
      <div class="status-flow-toolbar">
        <h2 v-if="heading" class="status-flow-heading" :title="heading">{{ heading }}</h2>
        <div class="status-flow-theme-control">
          <n-select
            :value="theme"
            :options="themeOptions"
            :disabled="themeSaving"
            size="small"
            :aria-label="t('opportunity.flowTheme')"
            @update:value="emit('selectTheme', $event as StatusFlowTheme)"
          />
        </div>
        <n-button
          quaternary
          circle
          size="small"
          class="status-flow-close"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click="emit('close')"
          >×</n-button
        >
      </div>

      <div class="status-flow-scroll">
        <div v-if="loading" class="status-flow-loading"><n-spin size="large" /></div>
        <div v-else-if="flow && flow.events.length === 0" class="status-flow-empty">
          {{ t('opportunity.flowEmpty') }}
        </div>
        <ol v-else-if="flow" class="status-flow-path">
          <li v-for="(event, index) in flow.events" :key="event.id" class="status-flow-step">
            <article class="status-flow-event">
              <span class="status-flow-order">{{ String(index + 1).padStart(2, '0') }}</span>
              <div class="status-flow-event-detail">
                <strong>{{ event.statusLabel }}</strong>
                <time :datetime="new Date(event.occurredAt).toISOString()">
                  {{ formatTime(event.occurredAt) }}
                </time>
              </div>
            </article>
          </li>
        </ol>
      </div>
    </n-card>
  </n-modal>
</template>
