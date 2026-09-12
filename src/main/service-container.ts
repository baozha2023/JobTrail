import type { AppPaths } from './config'
import { DatabaseManager } from './database'
import { FileStorageService } from './file-storage'
import { CalendarEventRepository } from './repositories/calendar-event-repository'
import { CompanyCatalogRepository } from './repositories/company-catalog-repository'
import { CompanyRepository } from './repositories/company-repository'
import { IndustryRepository } from './repositories/industry-repository'
import { OpportunityRepository } from './repositories/opportunity-repository'
import { ResumeRepository } from './repositories/resume-repository'
import { StatusRepository } from './repositories/status-repository'
import { CalendarEventService } from './services/calendar-event-service'
import { CalendarReminderService } from './services/calendar-reminder-service'
import { CompanyCatalogService } from './services/company-catalog-service'
import { CompanyService } from './services/company-service'
import { IndustryService } from './services/industry-service'
import { OpportunityService } from './services/opportunity-service'
import { ResumeService } from './services/resume-service'
import { StatusService } from './services/status-service'
import { UnitOfWork } from './services/unit-of-work'

export interface Services {
  statuses: StatusService
  industries: IndustryService
  companies: CompanyService
  companyCatalog: CompanyCatalogService
  resumes: ResumeService
  opportunities: OpportunityService
  calendar: CalendarEventService
  reminders: CalendarReminderService
}

export function createServiceContainer(
  paths: AppPaths,
  allowBuiltinEdit: boolean,
): {
  database: DatabaseManager
  unitOfWork: UnitOfWork
  services: Services
} {
  const database = new DatabaseManager(paths)
  const files = new FileStorageService(paths)
  const unitOfWork = new UnitOfWork(database.db)
  return {
    database,
    unitOfWork,
    services: createServices(unitOfWork, database, files, allowBuiltinEdit),
  }
}

export function createServices(
  unitOfWork: UnitOfWork,
  database: DatabaseManager,
  files: FileStorageService,
  allowBuiltinEdit: boolean,
): Services {
  const statusRepository = new StatusRepository(database.db)
  const industryRepository = new IndustryRepository(database.db)
  const companyRepository = new CompanyRepository(database.db)
  const companyCatalogRepository = new CompanyCatalogRepository(database.db)
  const resumeRepository = new ResumeRepository(database.db)
  const opportunityRepository = new OpportunityRepository(database.db)
  const calendarRepository = new CalendarEventRepository(database.db)
  return {
    statuses: new StatusService(unitOfWork, statusRepository, allowBuiltinEdit),
    industries: new IndustryService(unitOfWork, industryRepository, allowBuiltinEdit),
    companies: new CompanyService(
      unitOfWork,
      companyRepository,
      industryRepository,
      allowBuiltinEdit,
    ),
    companyCatalog: new CompanyCatalogService(unitOfWork, companyCatalogRepository),
    resumes: new ResumeService(unitOfWork, resumeRepository, files),
    opportunities: new OpportunityService(
      unitOfWork,
      opportunityRepository,
      companyRepository,
      statusRepository,
      resumeRepository,
    ),
    calendar: new CalendarEventService(unitOfWork, calendarRepository, opportunityRepository),
    reminders: new CalendarReminderService(unitOfWork, calendarRepository),
  }
}
