import type { AppPaths } from './config'
import { DatabaseManager } from './database'
import { FileStorageService } from './file-storage'
import { CalendarEventRepository } from './repositories/calendar-event-repository'
import { CompanyRepository } from './repositories/company-repository'
import { IndustryRepository } from './repositories/industry-repository'
import { OpportunityRepository } from './repositories/opportunity-repository'
import { ResumeRepository } from './repositories/resume-repository'
import { StatusRepository } from './repositories/status-repository'
import { CalendarEventService } from './services/calendar-event-service'
import { CalendarReminderService } from './services/calendar-reminder-service'
import { CompanyService } from './services/company-service'
import { IndustryService } from './services/industry-service'
import { OpportunityService } from './services/opportunity-service'
import { ResumeService } from './services/resume-service'
import { StatusService } from './services/status-service'

export interface Services {
  statuses: StatusService
  industries: IndustryService
  companies: CompanyService
  resumes: ResumeService
  opportunities: OpportunityService
  calendar: CalendarEventService
  reminders: CalendarReminderService
}

export function createServiceContainer(paths: AppPaths, allowBuiltinEdit: boolean): { database: DatabaseManager; files: FileStorageService; services: Services } {
  const database = new DatabaseManager(paths)
  const files = new FileStorageService(paths)
  return { database, files, services: createServices(database, files, allowBuiltinEdit) }
}

export function createServices(database: DatabaseManager, files: FileStorageService, allowBuiltinEdit: boolean): Services {
  const statusRepository = new StatusRepository(database.db)
  const industryRepository = new IndustryRepository(database.db)
  const companyRepository = new CompanyRepository(database.db)
  const resumeRepository = new ResumeRepository(database.db)
  const opportunityRepository = new OpportunityRepository(database.db)
  const calendarRepository = new CalendarEventRepository(database.db)
  return {
    statuses: new StatusService(statusRepository, allowBuiltinEdit),
    industries: new IndustryService(industryRepository, allowBuiltinEdit),
    companies: new CompanyService(companyRepository, industryRepository, allowBuiltinEdit),
    resumes: new ResumeService(resumeRepository, files),
    opportunities: new OpportunityService(opportunityRepository, companyRepository, statusRepository, resumeRepository),
    calendar: new CalendarEventService(calendarRepository, opportunityRepository),
    reminders: new CalendarReminderService(calendarRepository),
  }
}
