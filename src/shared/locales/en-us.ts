export default {
  EXAM_EXPORT_BUSY: 'An exam export is already running. Please wait.',
  EXAM_EXPORT_FAILED: 'Could not export the exam PDF. Check the save location and retry.',
  AGENT_QUEUE_FULL: 'This chat can queue up to three messages. Wait or remove a message.',
  AGENT_QUEUE_CHANGED: 'This queued message has started or changed. Refresh the queue.',
  COMPANY_EXISTS: 'This company already exists.',
  DISCOVERY_UNSUPPORTED_CITY:
    'This city is not supported by every selected site. Choose another city or change the sites.',
  DISCOVERY_JOB_OFFLINE: 'No longer available',
  DISCOVERY_UNAVAILABLE: 'Job discovery is unavailable. Start the desktop app and retry.',
  DISCOVERY_FAILED: 'Job retrieval did not complete. Check source status and retry.',
  WEB_BROWSER_UNAVAILABLE:
    'Microsoft Edge could not start, so dynamic web reading is unavailable. Install or update Edge; if the problem persists, repair the installation or check your organization’s browser policies.',
  EXAM_INVALID: 'Invalid question or answer. Check your input and retry.',
  EXAM_COUNTS_TOO_SMALL:
    'The target count for each question type cannot be lower than the number already generated.',
  EXAM_CONFLICT: 'The answer has changed. Refresh the paper and retry.',
  EXAM_NOT_FOUND: 'The paper or question was not found.',
  EXAM_ALREADY_GRADING: 'This answer is already being graded.',
  EXAM_UNAVAILABLE: 'Grading is temporarily unavailable. Please retry later.',
  EXAM_GRADING_FAILED: 'AI grading failed. Please retry.',
  PERSISTENCE_INVALID:
    'The database or configuration is invalid. Original data has been preserved.',
  PERSISTENCE_BUSY: 'Data maintenance is in progress. Please retry later.',
  PERSISTENCE_UNSUPPORTED: 'This data version is unsupported. Use a compatible newer client.',
  PERSISTENCE_FAILED: 'Data validation or upgrade failed. Check the logs and restart.',
} as const
