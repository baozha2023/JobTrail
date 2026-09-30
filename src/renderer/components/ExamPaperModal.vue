<script setup lang="ts">
import { computed } from 'vue'
import { NModal, NCard, NButton, NInput, NRadio, NRadioGroup, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useExamsStore } from '../stores/exams'
import AgentMarkdown from './AgentMarkdown.vue'
const store = useExamsStore(),
  { t } = useI18n()
const paper = computed(() => (store.selected ? store.papers[store.selected.paperId] : undefined))
const value = (id: string) => store.drafts[id]?.value
function close() {
  void store.close().catch((e) => {
    store.failure(e)
  })
}
</script>
<template>
  <NModal
    :show="!!paper"
    :mask-closable="false"
    @update:show="
      (show) => {
        if (!show) close()
      }
    "
  >
    <NCard
      v-if="paper"
      class="exam-modal"
      content-class="exam-modal-content"
      :title="paper.title"
      closable
      @close="close"
      role="dialog"
      aria-modal="true"
    >
      <template #header-extra
        ><NButton size="small" @click="store.reset(paper.id)">{{
          t('exam.reset')
        }}</NButton></template
      >
      <div class="exam-questions">
        <section v-for="q in paper.questions" :key="q.id" class="exam-question">
          <small>{{ q.position }} · {{ t(`exam.${q.content.type}`) }}</small>
          <AgentMarkdown :text="q.content.prompt" />
          <NRadioGroup
            v-if="q.content.type === 'single_choice'"
            :value="typeof value(q.id) === 'string' ? String(value(q.id)) : null"
            @update:value="(v) => store.edit(paper!.id, q.id, String(v))"
          >
            <NSpace vertical
              ><NRadio
                v-for="(option, index) in q.content.options"
                :key="index"
                :value="'ABCD'[index]"
                ><div class="exam-option">
                  <strong>{{ 'ABCD'[index] }}.</strong
                  ><AgentMarkdown :text="option" /></div></NRadio
            ></NSpace>
          </NRadioGroup>
          <NRadioGroup
            v-else-if="q.content.type === 'true_false'"
            :value="typeof value(q.id) === 'boolean' ? String(value(q.id)) : null"
            @update:value="(v) => store.edit(paper!.id, q.id, v === 'true')"
            ><NSpace
              ><NRadio value="true">{{ t('exam.true') }}</NRadio
              ><NRadio value="false">{{ t('exam.false') }}</NRadio></NSpace
            ></NRadioGroup
          >
          <NInput
            v-else
            type="textarea"
            :value="typeof value(q.id) === 'string' ? String(value(q.id)) : ''"
            :autosize="{ minRows: 4, maxRows: 16 }"
            :maxlength="30000"
            :placeholder="t('exam.answerPlaceholder')"
            @update:value="(v) => store.edit(paper!.id, q.id, v)"
            @blur="store.save(paper.id, q.id).catch((e) => store.failure(e))"
          />
          <div class="exam-actions">
            <NButton
              type="primary"
              size="small"
              :loading="
                ['queued', 'running'].includes(q.answer.gradeStatus) && !store.drafts[q.id]?.dirty
              "
              :disabled="
                value(q.id) === null ||
                (!!q.answer.result && !store.drafts[q.id]?.dirty) ||
                (q.content.type === 'short_answer' && !String(value(q.id) ?? '').trim())
              "
              @click="store.submit(paper.id, q.id)"
              >{{ t(q.content.type === 'short_answer' ? 'exam.grade' : 'exam.submit') }}</NButton
            ><small v-if="['error', 'interrupted'].includes(q.answer.gradeStatus)">{{
              t('exam.retry')
            }}</small>
          </div>
          <div v-if="q.answer.result && !store.drafts[q.id]?.dirty" class="exam-result">
            <template v-if="'score' in q.answer.result"
              ><strong>{{ t('exam.score', { score: q.answer.result.score }) }}</strong
              ><AgentMarkdown :text="q.answer.result.evaluation" /><strong>{{
                t('exam.reference')
              }}</strong
              ><AgentMarkdown :text="q.answer.result.referenceAnswer"
            /></template>
            <template v-else
              ><strong
                >{{ t(q.answer.result.correct ? 'exam.correct' : 'exam.incorrect') }} ·
                {{ t('exam.correctAnswer') }}
                {{
                  typeof q.answer.result.answer === 'boolean'
                    ? t(q.answer.result.answer ? 'exam.true' : 'exam.false')
                    : q.answer.result.answer
                }}</strong
              ><AgentMarkdown :text="q.answer.result.explanation"
            /></template>
          </div>
        </section>
      </div>
    </NCard>
  </NModal>
</template>
<style scoped>
.exam-modal {
  width: 70vw;
  height: 90vh;
  overflow: hidden;
}
.exam-modal :deep(.exam-modal-content) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.exam-questions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-width: thin;
  scrollbar-color: #8888 transparent;
  padding-right: 12px;
}
.exam-question {
  padding: 20px 0;
  border-bottom: 1px solid #8883;
}
.exam-question > small {
  opacity: 0.65;
}
.exam-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 14px;
}
.exam-result {
  margin-top: 14px;
  padding: 16px;
  border-radius: 8px;
  background: #8b7bd112;
}
.exam-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.exam-option :deep(p) {
  margin: 0;
}
</style>
