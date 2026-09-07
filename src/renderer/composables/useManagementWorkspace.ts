import { computed, ref, toRaw, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  Company,
  CreateCompanyInput,
  CreateIndustryInput,
  Industry,
  ResumeVersion,
  Status,
  UpdateResumeVersionInput,
} from '../../shared/types'

type CompanyForm = Omit<CreateCompanyInput, 'aliases' | 'industryIds'> & {
  industryIds: number[]
  aliases: string[]
}

interface ManagementWorkspaceOptions {
  statuses: Ref<Status[]>
  industries: Ref<Industry[]>
  resumes: Ref<ResumeVersion[]>
  companies: Ref<Company[]>
  loadCompanies: () => Promise<void>
  loadOpportunities: () => Promise<void>
  loadAllOpportunities: () => Promise<void>
  loadCalendar: () => Promise<void>
  showError: (error: unknown) => void
  notifySuccess: (text: string) => void
  notifyError: (text: string) => void
}

export function useManagementWorkspace(options: ManagementWorkspaceOptions) {
  const { t } = useI18n()
  const showStatusModal = ref(false)
  const editingStatusId = ref<number | null>(null)
  const statusForm = ref({ label: '' })
  const showResumeModal = ref(false)
  const editingResumeId = ref<number | null>(null)
  const resumeForm = ref<UpdateResumeVersionInput>({ name: '', note: null })
  const showCompanyModal = ref(false)
  const editingCompanyId = ref<number | null>(null)
  const companyManagementSearch = ref('')
  const companyAliasInput = ref('')
  const companyForm = ref<CompanyForm>({ name: '', industryIds: [], careerUrl: null, aliases: [] })
  const showIndustryModal = ref(false)
  const editingIndustryId = ref<number | null>(null)
  const industryForm = ref<CreateIndustryInput>({ name: '' })

  const managedCompanies = computed(() => {
    const keyword = companyManagementSearch.value.trim().toLocaleLowerCase()
    if (!keyword) return options.companies.value
    return options.companies.value.filter((company) =>
      [company.name, company.industryName, company.careerUrl, ...company.aliases].some((value) =>
        value?.toLocaleLowerCase().includes(keyword),
      ),
    )
  })

  async function moveStatus(id: number, offset: number): Promise<void> {
    const reordered = reorderedIds(options.statuses.value, id, offset)
    if (!reordered) return
    try {
      options.statuses.value = await window.zhijiApi.statuses.reorder(reordered)
      options.notifySuccess(t('feedback.reorderSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function moveIndustry(id: number, offset: number): Promise<void> {
    const reordered = reorderedIds(options.industries.value, id, offset)
    if (!reordered) return
    try {
      options.industries.value = await window.zhijiApi.industries.reorder(reordered)
      options.notifySuccess(t('feedback.reorderSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function moveResume(id: number, offset: number): Promise<void> {
    const reordered = reorderedIds(options.resumes.value, id, offset)
    if (!reordered) return
    try {
      options.resumes.value = await window.zhijiApi.resumes.reorder(reordered)
      options.notifySuccess(t('feedback.reorderSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  function openStatusEditor(status?: Status): void {
    editingStatusId.value = status?.id ?? null
    statusForm.value = { label: status?.label ?? '' }
    showStatusModal.value = true
  }

  async function saveStatus(): Promise<void> {
    if (!statusForm.value.label.trim()) {
      options.notifyError(t('error.required'))
      return
    }
    try {
      const isEditing = editingStatusId.value !== null
      const input = cloneDto(statusForm.value)
      if (isEditing) await window.zhijiApi.statuses.update(editingStatusId.value!, input)
      else await window.zhijiApi.statuses.create(input)
      options.statuses.value = await window.zhijiApi.statuses.list()
      showStatusModal.value = false
      await Promise.all([options.loadOpportunities(), options.loadAllOpportunities()])
      options.notifySuccess(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteStatus(status: Status): Promise<void> {
    try {
      await window.zhijiApi.statuses.delete(status.id)
      options.statuses.value = options.statuses.value.filter((item) => item.id !== status.id)
      await options.loadOpportunities()
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function importResume(): Promise<void> {
    try {
      const imported = await window.zhijiApi.resumes.import()
      if (!imported) return
      options.resumes.value = await window.zhijiApi.resumes.list()
      options.notifySuccess(t('feedback.importSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  function openResumeEditor(resume: ResumeVersion): void {
    editingResumeId.value = resume.id
    resumeForm.value = { name: resume.name, note: resume.note }
    showResumeModal.value = true
  }

  async function saveResume(): Promise<void> {
    if (editingResumeId.value === null || !resumeForm.value.name?.trim()) {
      options.notifyError(t('error.required'))
      return
    }
    try {
      await window.zhijiApi.resumes.update(editingResumeId.value, cloneDto(resumeForm.value))
      options.resumes.value = await window.zhijiApi.resumes.list()
      showResumeModal.value = false
      await Promise.all([options.loadOpportunities(), options.loadAllOpportunities()])
      options.notifySuccess(t('feedback.editSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteResume(resume: ResumeVersion): Promise<void> {
    try {
      await window.zhijiApi.resumes.delete(resume.id)
      options.resumes.value = options.resumes.value.filter((item) => item.id !== resume.id)
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function openResume(id: number): Promise<void> {
    try {
      await window.zhijiApi.resumes.open(id)
    } catch (error) {
      options.showError(error)
    }
  }

  function openIndustryEditor(industry?: Industry): void {
    editingIndustryId.value = industry?.id ?? null
    industryForm.value = { name: industry?.name ?? '' }
    showIndustryModal.value = true
  }

  async function saveIndustry(): Promise<void> {
    if (!industryForm.value.name.trim()) {
      options.notifyError(t('error.required'))
      return
    }
    try {
      const isEditing = editingIndustryId.value !== null
      const input = cloneDto(industryForm.value)
      if (isEditing) await window.zhijiApi.industries.update(editingIndustryId.value!, input)
      else await window.zhijiApi.industries.create(input)
      options.industries.value = await window.zhijiApi.industries.list()
      await options.loadCompanies()
      showIndustryModal.value = false
      options.notifySuccess(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteIndustry(industry: Industry): Promise<void> {
    try {
      await window.zhijiApi.industries.delete(industry.id)
      options.industries.value = options.industries.value.filter((item) => item.id !== industry.id)
      await options.loadCompanies()
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  function openCompanyEditor(company?: Company): void {
    editingCompanyId.value = company?.id ?? null
    companyForm.value = {
      name: company?.name ?? '',
      industryIds: company?.industryIds ? [...company.industryIds] : [],
      careerUrl: company?.careerUrl ?? null,
      aliases: company?.aliases ? [...company.aliases] : [],
    }
    companyAliasInput.value = ''
    showCompanyModal.value = true
  }

  function commitCompanyAliasInput(): void {
    const pendingAliases = companyAliasInput.value.split(/[,，\n]/)
    companyForm.value.aliases = normalizeAliases([...companyForm.value.aliases, ...pendingAliases])
    companyAliasInput.value = ''
  }

  function removeCompanyAlias(index: number): void {
    companyForm.value.aliases = companyForm.value.aliases.filter(
      (_alias, aliasIndex) => aliasIndex !== index,
    )
  }

  async function saveCompany(): Promise<void> {
    if (!companyForm.value.name.trim()) {
      options.notifyError(t('error.required'))
      return
    }
    const input = {
      name: companyForm.value.name,
      industryIds: [...companyForm.value.industryIds],
      careerUrl: companyForm.value.careerUrl,
      aliases: normalizeAliases(companyForm.value.aliases),
    }
    try {
      const isEditing = editingCompanyId.value !== null
      if (isEditing) await window.zhijiApi.companies.update(editingCompanyId.value!, input)
      else await window.zhijiApi.companies.create(input)
      await Promise.all([
        options.loadCompanies(),
        options.loadOpportunities(),
        options.loadAllOpportunities(),
        options.loadCalendar(),
      ])
      showCompanyModal.value = false
      options.notifySuccess(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function toggleCompanyFavorite(company: Company): Promise<void> {
    try {
      await window.zhijiApi.companies.update(company.id, { isFavorite: !company.isFavorite })
      await options.loadCompanies()
      options.notifySuccess(
        t(company.isFavorite ? 'feedback.unfavoriteSuccess' : 'feedback.favoriteSuccess'),
      )
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteCompany(company: Company): Promise<void> {
    try {
      await window.zhijiApi.companies.delete(company.id)
      await Promise.all([options.loadCompanies(), options.loadOpportunities()])
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  return {
    showStatusModal,
    editingStatusId,
    statusForm,
    showResumeModal,
    editingResumeId,
    resumeForm,
    showCompanyModal,
    editingCompanyId,
    companyManagementSearch,
    companyAliasInput,
    companyForm,
    showIndustryModal,
    editingIndustryId,
    industryForm,
    managedCompanies,
    moveStatus,
    moveIndustry,
    moveResume,
    openStatusEditor,
    saveStatus,
    deleteStatus,
    importResume,
    openResumeEditor,
    saveResume,
    deleteResume,
    openResume,
    openIndustryEditor,
    saveIndustry,
    deleteIndustry,
    openCompanyEditor,
    commitCompanyAliasInput,
    removeCompanyAlias,
    saveCompany,
    toggleCompanyFavorite,
    deleteCompany,
  }
}

function cloneDto<T extends object>(value: T): T {
  return structuredClone(toRaw(value))
}

function reorderedIds<T extends { id: number }>(
  items: T[],
  id: number,
  offset: number,
): number[] | null {
  const reordered = items.map((item) => item.id)
  const index = reordered.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= reordered.length) return null
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  return reordered
}

function normalizeAliases(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
