import { ref, toRaw, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { Company, CreateOpportunityInput, Opportunity, Status } from '../../shared/types'
import { useOpportunitiesStore } from '../stores/opportunities'

interface OpportunityWorkspaceOptions {
  companies: Ref<Company[]>
  statuses: Ref<Status[]>
  loadCalendar: () => Promise<void>
  showError: (error: unknown) => void
  notifySuccess: (text: string) => void
  notifyError: (text: string) => void
}

export function useOpportunityWorkspace(options: OpportunityWorkspaceOptions) {
  const { t } = useI18n()
  const store = useOpportunitiesStore()
  const {
    items: opportunities,
    allItems: allOpportunities,
    loading: opportunitiesLoading,
  } = storeToRefs(store)
  const search = ref('')
  const selectedStatusId = ref<number | null>(null)
  const selectedCompanyId = ref<number | null>(null)
  const showOpportunityModal = ref(false)
  const editingOpportunityId = ref<number | null>(null)
  const opportunityForm = ref<CreateOpportunityInput>(emptyOpportunityInput())

  async function loadOpportunities(): Promise<void> {
    await store.load({
      search: search.value,
      statusId: selectedStatusId.value,
      companyId: selectedCompanyId.value,
    })
  }

  async function loadAllOpportunities(): Promise<void> {
    await store.loadAll()
  }

  function refreshOpportunities(): void {
    void loadOpportunities().catch(options.showError)
  }

  function newOpportunity(): void {
    editingOpportunityId.value = null
    opportunityForm.value = {
      ...emptyOpportunityInput(),
      companyId: options.companies.value[0]?.id ?? 0,
      statusId:
        options.statuses.value.find((item) => item.label === '待投递')?.id ??
        options.statuses.value[0]?.id ??
        0,
    }
    showOpportunityModal.value = true
  }

  function openOpportunity(row: Opportunity): void {
    editingOpportunityId.value = row.id
    opportunityForm.value = {
      companyId: row.companyId,
      title: row.title,
      department: row.department,
      location: row.location,
      source: row.source,
      jobUrl: row.jobUrl,
      description: row.description,
      statusId: row.statusId,
      resumeVersionId: row.resumeVersionId,
      discoveredAt: row.discoveredAt,
      appliedAt: row.appliedAt,
      deadlineAt: row.deadlineAt,
      notes: row.notes,
    }
    showOpportunityModal.value = true
  }

  async function saveOpportunity(): Promise<void> {
    if (
      !opportunityForm.value.companyId ||
      !opportunityForm.value.statusId ||
      !opportunityForm.value.title.trim()
    ) {
      options.notifyError(t('error.required'))
      return
    }
    try {
      const isEditing = editingOpportunityId.value !== null
      const input = structuredClone(toRaw(opportunityForm.value))
      if (isEditing) await window.zhijiApi.opportunities.update(editingOpportunityId.value!, input)
      else await window.zhijiApi.opportunities.create(input)
      showOpportunityModal.value = false
      await Promise.all([loadOpportunities(), loadAllOpportunities(), options.loadCalendar()])
      options.notifySuccess(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteOpportunity(id: number): Promise<void> {
    try {
      await window.zhijiApi.opportunities.delete(id)
      await Promise.all([loadOpportunities(), loadAllOpportunities(), options.loadCalendar()])
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  watch([search, selectedStatusId, selectedCompanyId], () => {
    void loadOpportunities().catch(options.showError)
  })

  return {
    opportunities,
    allOpportunities,
    opportunitiesLoading,
    search,
    selectedStatusId,
    selectedCompanyId,
    showOpportunityModal,
    editingOpportunityId,
    opportunityForm,
    loadOpportunities,
    loadAllOpportunities,
    refreshOpportunities,
    newOpportunity,
    openOpportunity,
    saveOpportunity,
    deleteOpportunity,
  }
}

function emptyOpportunityInput(): CreateOpportunityInput {
  return {
    companyId: 0,
    title: '',
    department: null,
    location: null,
    source: null,
    jobUrl: null,
    description: null,
    statusId: 0,
    resumeVersionId: null,
    discoveredAt: Date.now(),
    appliedAt: null,
    deadlineAt: null,
    notes: null,
  }
}
