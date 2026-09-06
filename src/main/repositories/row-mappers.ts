import type {
  CalendarEvent,
  Company,
  Industry,
  Opportunity,
  ResumeVersion,
  Status,
} from '../../shared/types'

export interface StatusRow {
  id: number
  label: string
  sort_order: number
  is_builtin: number
  created_at: number
  updated_at: number
}

export interface IndustryRow {
  id: number
  name: string
  sort_order: number
  is_builtin: number
  created_at: number
  updated_at: number
}

export interface CompanyRow {
  id: number
  name: string
  industry_name: string | null
  career_url: string | null
  last_read_at: number | null
  is_builtin: number
  is_favorite: number
  created_at: number
  updated_at: number
}

export interface CompanyAliasRow {
  id: number
  company_id: number
  alias: string
  created_at: number
}

export interface ResumeRow {
  id: number
  name: string
  relative_path: string
  size_bytes: number | null
  sha256: string | null
  note: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export interface OpportunityRow {
  id: number
  company_id: number
  company_name: string
  title: string
  department: string | null
  location: string | null
  source: string | null
  job_url: string | null
  description: string | null
  status_id: number
  status_label: string
  resume_version_id: number | null
  resume_version_name: string | null
  discovered_at: number | null
  applied_at: number | null
  deadline_at: number | null
  notes: string | null
  created_at: number
  updated_at: number
}

export interface CalendarEventRow {
  id: number
  opportunity_id: number | null
  opportunity_title: string | null
  opportunity_job_url: string | null
  company_name: string | null
  title: string
  event_type: string
  start_at: number
  end_at: number
  is_all_day: number
  timezone: string
  location: string | null
  description: string | null
  reminder_minutes: number | null
  is_completed: number
  created_at: number
  updated_at: number
}

export function mapStatus(row: StatusRow): Status {
  return { id: row.id, label: row.label, sortOrder: row.sort_order, isBuiltin: row.is_builtin === 1, createdAt: row.created_at, updatedAt: row.updated_at }
}

export function mapIndustry(row: IndustryRow): Industry {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, isBuiltin: row.is_builtin === 1, createdAt: row.created_at, updatedAt: row.updated_at }
}

export function mapCompany(row: CompanyRow, aliases: string[], industryIds: number[]): Company {
  return {
    id: row.id,
    name: row.name,
    industryIds,
    industryName: row.industry_name,
    careerUrl: row.career_url,
    lastReadAt: row.last_read_at,
    aliases,
    isBuiltin: row.is_builtin === 1,
    isFavorite: row.is_favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapResume(row: ResumeRow): ResumeVersion {
  return {
    id: row.id,
    name: row.name,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    note: row.note,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    title: row.title,
    department: row.department,
    location: row.location,
    source: row.source,
    jobUrl: row.job_url,
    description: row.description,
    statusId: row.status_id,
    statusLabel: row.status_label,
    resumeVersionId: row.resume_version_id,
    resumeVersionName: row.resume_version_name,
    discoveredAt: row.discovered_at,
    appliedAt: row.applied_at,
    deadlineAt: row.deadline_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    opportunityTitle: row.opportunity_title,
    opportunityJobUrl: row.opportunity_job_url,
    companyName: row.company_name,
    title: row.title,
    eventType: row.event_type,
    startAt: row.start_at,
    endAt: row.end_at,
    isAllDay: row.is_all_day === 1,
    timezone: row.timezone,
    location: row.location,
    description: row.description,
    reminderMinutes: row.reminder_minutes,
    isCompleted: row.is_completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
