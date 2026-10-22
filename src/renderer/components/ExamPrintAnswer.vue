<script setup lang="ts">
import type { ExamPdfSnapshot } from '../../shared/exams'
import AgentMarkdown from './AgentMarkdown.vue'
defineProps<{
  question: ExamPdfSnapshot['questions'][number]
  labels: {
    reference: string
    correctAnswer: string
    true: string
    false: string
    explanation: string
  }
}>()
</script>
<template>
  <div class="print-answer">
    <template v-if="question.content.type === 'short_answer'">
      <strong>{{ labels.reference }}：</strong>
      <AgentMarkdown v-if="question.defaultAnswer !== null" :text="question.defaultAnswer" />
      <div v-else class="blank-answer"></div>
    </template>
    <template v-else>
      <p>
        <strong>{{ labels.correctAnswer }}</strong>
        {{
          question.content.type === 'true_false'
            ? question.content.correct
              ? labels.true
              : labels.false
            : question.content.correct
        }}
      </p>
      <strong>{{ labels.explanation }}：</strong>
      <AgentMarkdown :text="question.content.explanation" />
    </template>
  </div>
</template>
