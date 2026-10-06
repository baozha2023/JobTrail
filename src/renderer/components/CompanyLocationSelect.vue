<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  companyLocationsInputSchema,
  normalizeCompanyLocations,
} from '../../shared/company-locations'
import { getErrorMessage } from '../utils/errors'

const props = defineProps<{ value: string[]; allowCreate?: boolean; revision: number }>()
const emit = defineEmits<{ 'update:value': [value: string[]] }>()
const { t } = useI18n()
const items = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const total = ref(0)
const page = ref(0)
const prefix = ref('')
let open = false
let request = 0
let debounce: ReturnType<typeof setTimeout> | undefined
const options = computed(() => {
  // Match SQLite LIKE's ASCII case folding. Selected values remain in `value`
  // even when a different prefix or page removes them from the menu.
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const values = [
    ...new Set([
      ...props.value.filter((value) => fold(value).startsWith(fold(prefix.value))),
      ...items.value,
    ]),
  ]
  // Naive UI's native tag creation is disabled in remote mode. A valid draft
  // is a local option only; the company save is the first database write.
  if (
    props.allowCreate &&
    companyLocationsInputSchema.safeParse([prefix.value]).success &&
    !values.includes(prefix.value)
  )
    values.unshift(prefix.value)
  return values.map((value) => ({ label: value, value }))
})

function invalidate(): void {
  clearTimeout(debounce)
  request++
  loading.value = false
  items.value = []
  total.value = 0
  page.value = 0
}

async function loadNext(): Promise<void> {
  if (!open || loading.value || (page.value > 0 && page.value * 50 >= total.value)) return
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const result = await window.zhijiApi.companies.searchLocations({
      prefix: prefix.value,
      page: page.value + 1,
      pageSize: 50,
    })
    if (request !== current) return
    items.value = [...new Set([...items.value, ...result.items])]
    total.value = result.total
    page.value = result.page
  } catch (cause) {
    if (request === current) error.value = getErrorMessage(cause, t)
  } finally {
    if (request === current) loading.value = false
  }
}

function changeOpen(value: boolean): void {
  open = value
  invalidate()
  if (open) {
    prefix.value = ''
    void loadNext()
  }
}

function search(value: string): void {
  prefix.value = value.trim()
  invalidate()
  debounce = setTimeout(() => void loadNext(), 200)
}

function scroll(event: Event): void {
  const target = event.target as HTMLElement
  if (target.scrollHeight - target.scrollTop - target.clientHeight <= 40) void loadNext()
}

function update(value: string[]): void {
  const parsed = companyLocationsInputSchema.safeParse(value)
  if (!parsed.success) {
    error.value = t('management.companyLocationsInvalid')
    return
  }
  error.value = ''
  emit('update:value', normalizeCompanyLocations(parsed.data))
}

watch(
  () => props.revision,
  () => {
    invalidate()
    if (open) void loadNext()
  },
)
onBeforeUnmount(invalidate)
</script>

<template>
  <div class="company-location-select">
    <n-select
      :value="value"
      :options="options"
      :loading="loading"
      :fallback-option="(value: string | number) => ({ label: String(value), value })"
      :placeholder="
        t(
          allowCreate
            ? 'management.companyLocationsPlaceholder'
            : 'management.companyLocationsFilter',
        )
      "
      multiple
      filterable
      clearable
      remote
      max-tag-count="responsive"
      :reset-menu-on-options-change="page <= 1"
      @update:value="update"
      @update:show="changeOpen"
      @search="search"
      @scroll="scroll"
    />
    <p v-if="error" class="location-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.company-location-select {
  min-width: 220px;
  width: 100%;
}
.location-error {
  color: var(--error-color, #d03050);
  margin: 4px 0 0;
  font-size: 12px;
}
</style>
