<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AgentDraftPart } from '../../shared/types'
import { agentReferenceLabel } from './agent-reference'

defineProps<{ parts: AgentDraftPart[] }>()
const { t } = useI18n()
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <span v-if="part.kind === 'text'">{{ part.text }}</span>
    <span v-else class="agent-reference" :title="agentReferenceLabel(part, t)">{{
      agentReferenceLabel(part, t)
    }}</span>
  </template>
</template>
