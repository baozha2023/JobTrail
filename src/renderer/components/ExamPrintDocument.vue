<script setup lang="ts">
import { computed, type ShallowRef } from 'vue'
import type { ExamPrintDocument } from '../../shared/exams'
import zhCn from '../locales/zh-cn'
import enUs from '../locales/en-us'
import AgentMarkdown from './AgentMarkdown.vue'
import ExamPrintAnswer from './ExamPrintAnswer.vue'
const props = defineProps<{ documentData: ShallowRef<ExamPrintDocument | undefined> }>()
const data = computed(() => props.documentData.value)
const labels = computed(() => (data.value?.locale === 'en-US' ? enUs : zhCn).exam)
const target = computed(() =>
  Object.values(data.value?.paper.counts ?? {}).reduce((sum, count) => sum + count, 0),
)
</script>
<template>
  <main v-if="data" class="exam-print">
    <header class="print-title">
      <h1>{{ data.paper.title }}</h1>
      <p>
        {{ labels.topic }}：{{ data.paper.topic }} · {{ labels.difficulty }}：{{
          data.paper.difficulty
        }}
      </p>
      <p>
        {{ labels.questionCount }}：{{ data.paper.questions.length }} / {{ target
        }}<strong v-if="data.paper.status !== 'completed'"> · {{ labels.incomplete }}</strong>
      </p>
    </header>
    <section
      v-for="question in data.paper.questions"
      :key="question.position"
      class="print-question"
    >
      <h2>{{ question.position }} · {{ labels[question.content.type] }}</h2>
      <AgentMarkdown :text="question.content.prompt" />
      <div v-if="question.content.type === 'single_choice'" class="print-options">
        <div v-for="(option, index) in question.content.options" :key="index" class="print-option">
          <strong>{{ 'ABCD'[index] }}.</strong><AgentMarkdown :text="option" />
        </div>
      </div>
      <ExamPrintAnswer
        v-if="data.answerPlacement === 'after_each'"
        :question="question"
        :labels="labels"
      />
    </section>
    <section v-if="data.answerPlacement === 'at_end'" class="print-answer-section">
      <h1>{{ labels.answersAndExplanations }}</h1>
      <section
        v-for="question in data.paper.questions"
        :key="question.position"
        class="print-question"
      >
        <h2>{{ question.position }} · {{ labels[question.content.type] }}</h2>
        <ExamPrintAnswer :question="question" :labels="labels" />
      </section>
    </section>
  </main>
</template>
<style>
@page {
  size: A4;
  margin: 16.5mm 16.5mm 18mm;
}
html,
body {
  margin: 0;
  padding: 0;
  background: white;
  color: #18202b;
  font:
    11pt/1.65 'Microsoft YaHei',
    'SimSun',
    Arial,
    sans-serif;
}
* {
  box-sizing: border-box;
}
.exam-print {
  overflow-wrap: anywhere;
}
.print-title {
  padding-bottom: 6mm;
  border-bottom: 1px solid #ccd2da;
  margin-bottom: 7mm;
}
.print-title p {
  margin: 2mm 0;
  color: #475364;
}
h1 {
  font-size: 21pt;
  line-height: 1.4;
  margin: 0 0 4mm;
}
h2 {
  font-size: 12pt;
  margin: 0 0 3mm;
  break-after: avoid;
}
.print-question {
  margin-bottom: 7mm;
}
.print-option {
  display: flex;
  align-items: baseline;
  gap: 3mm;
  margin: 2mm 0;
}
.print-option > strong {
  flex: 0 0 5mm;
}
.print-option > .agent-markdown {
  min-width: 0;
  flex: 1;
}
.print-option p {
  margin: 0;
}
.print-answer {
  padding-top: 3mm;
  margin-top: 3mm;
  border-top: 1px solid #e3e7ec;
}
.print-answer > strong {
  display: block;
  break-after: avoid;
  margin-bottom: 1mm;
}
.print-answer p {
  margin: 0 0 2mm;
}
.blank-answer {
  height: 7mm;
}
.print-answer-section {
  break-before: page;
}
.exam-print .agent-markdown {
  color: inherit;
}
.exam-print .agent-markdown pre {
  white-space: pre-wrap;
  overflow: visible;
  overflow-wrap: anywhere;
  word-break: break-word;
  border: 1px solid #e0e5eb;
}
.exam-print .agent-markdown code {
  font-family: Consolas, 'Microsoft YaHei', monospace;
}
.exam-print .agent-markdown table {
  display: table;
  width: 100%;
  table-layout: fixed;
  overflow: visible;
  font-size: 10pt;
}
.exam-print .agent-markdown th,
.exam-print .agent-markdown td {
  overflow-wrap: anywhere;
}
.exam-print .agent-markdown thead {
  display: table-header-group;
}
.exam-print .agent-markdown tr {
  break-inside: avoid;
}
.exam-print .agent-markdown a {
  color: inherit;
}
p {
  orphans: 3;
  widows: 3;
}
</style>
