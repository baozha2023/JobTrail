<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useExamsStore } from '../stores/exams'
const props = defineProps<{ paperId: string; conversationId: string }>()
const store = useExamsStore(),
  { t } = useI18n()
const paper = computed(() => store.papers[props.paperId])
const total = computed(() =>
  paper.value ? Object.values(paper.value.counts).reduce((a, b) => a + b, 0) : 0,
)
onMounted(() => {
  store.start()
  void store.load(props).catch((e) => store.failure(e))
})
</script>
<template>
  <button class="exam-card" type="button" @click="store.open(props).catch((e) => store.failure(e))">
    <span class="exam-icon" aria-hidden="true">▤</span>
    <span
      ><strong>{{ paper?.title || t('exam.paper') }}</strong
      ><small v-if="paper"
        >{{
          t('exam.progress', {
            generated: paper.questions.length,
            total,
            answered: paper.questions.filter((q) => q.answer.submitted).length,
          })
        }}
        · {{ t(`exam.${paper.status}`) }}</small
      ><small v-else>{{ t('exam.loading') }}</small></span
    >
    <span>{{ t('exam.open') }} →</span>
  </button>
</template>
<style scoped>
.exam-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  width: min(100%, 600px);
  text-align: left;
  border: 1px solid #8b7bd166;
  border-radius: 14px;
  background: linear-gradient(120deg, #8b7bd118, #479ad510);
  color: inherit;
  cursor: pointer;
  font: inherit;
  margin: 12px 0;
}
.exam-card:hover {
  border-color: #8b7bd1;
}
.exam-card span:nth-child(2) {
  flex: 1;
}
.exam-card strong,
.exam-card small {
  display: block;
}
.exam-card small {
  opacity: 0.75;
  margin-top: 6px;
}
.exam-icon {
  font-size: 30px;
  color: #9680db;
}
</style>
