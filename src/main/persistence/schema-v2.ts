const CHAT_EVENTS_V2 = `CREATE TABLE agent_chat_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'compact', 'exam-paper')),
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`

const MODEL_USAGE_V2 = `CREATE TABLE agent_model_usage (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'compact', 'grade')),
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        created_at INTEGER NOT NULL
      );`

const EXAM_SCHEMA = `
CREATE TABLE exam_papers (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
 task_id TEXT NOT NULL, title TEXT NOT NULL, topic TEXT NOT NULL, difficulty TEXT NOT NULL,
 counts TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('generating','completed','interrupted')),
 reset_version INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_exam_papers_conversation ON exam_papers(conversation_id, created_at);
CREATE TABLE exam_questions (
 id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
 position INTEGER NOT NULL, content TEXT NOT NULL, UNIQUE(paper_id, position)
);
CREATE TABLE exam_answers (
 question_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, value TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0, submitted INTEGER NOT NULL DEFAULT 0 CHECK(submitted IN (0,1)),
 result TEXT, grade_request_id TEXT, grade_status TEXT NOT NULL DEFAULT 'idle'
 CHECK(grade_status IN ('idle','queued','running','completed','error','interrupted')),
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_exam_answers_paper ON exam_answers(paper_id);
`

export const SCHEMA_V2 = `
      CREATE TABLE statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE industries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER CHECK (parent_id IS NULL OR (parent_id > 0 AND parent_id <> id)),
        builtin_key TEXT UNIQUE,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (parent_id IS NOT NULL OR builtin_key IS NOT NULL)
      );

      CREATE TABLE companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        builtin_key TEXT UNIQUE,
        career_url TEXT,
        last_read_at INTEGER,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE builtin_company_catalog_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL,
        catalog_version INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE company_industries (
        company_id INTEGER NOT NULL,
        industry_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (company_id, industry_id)
      );

      CREATE TABLE company_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(company_id, alias)
      );

      CREATE TABLE resume_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT,
        note TEXT,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_finalized INTEGER NOT NULL DEFAULT 0 CHECK (title_finalized IN (0, 1)),
        deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1)),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      ${CHAT_EVENTS_V2}

      ${MODEL_USAGE_V2}

      CREATE TABLE chat_attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1)),
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        department TEXT,
        location TEXT,
        source TEXT,
        job_url TEXT,
        description TEXT,
        status_id INTEGER NOT NULL,
        resume_version_id INTEGER,
        discovered_at INTEGER,
        applied_at INTEGER,
        deadline_at INTEGER,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE opportunity_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER NOT NULL,
        status_id INTEGER NOT NULL,
        status_label TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'changed'))
      );

      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL CHECK (end_at >= start_at),
        is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
        timezone TEXT NOT NULL,
        location TEXT,
        description TEXT,
        reminder_minutes INTEGER CHECK (reminder_minutes IS NULL OR reminder_minutes >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE calendar_event_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calendar_event_id INTEGER NOT NULL,
        reminder_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        UNIQUE(calendar_event_id, reminder_at)
      );

      CREATE INDEX idx_opportunities_status_id ON opportunities(status_id);
      CREATE INDEX idx_opportunity_status_events_flow ON opportunity_status_events(opportunity_id, occurred_at, id);
      CREATE INDEX idx_opportunity_status_events_status_id ON opportunity_status_events(status_id);
      CREATE INDEX idx_opportunities_company_id ON opportunities(company_id);
      CREATE INDEX idx_opportunities_deadline_at ON opportunities(deadline_at);
      CREATE INDEX idx_opportunities_updated_at ON opportunities(updated_at);
      CREATE UNIQUE INDEX idx_industries_root_name ON industries(name) WHERE parent_id IS NULL;
      CREATE UNIQUE INDEX idx_industries_child_name ON industries(parent_id, name) WHERE parent_id IS NOT NULL;
      CREATE INDEX idx_industries_parent_order ON industries(parent_id, sort_order, id);
      CREATE INDEX idx_company_industries_industry_id ON company_industries(industry_id);
      CREATE INDEX idx_calendar_events_range ON calendar_events(start_at, end_at);
      CREATE INDEX idx_agent_conversations_updated_at ON agent_conversations(updated_at DESC);
      CREATE INDEX idx_agent_chat_events_conversation ON agent_chat_events(conversation_id, seq);
      CREATE INDEX idx_agent_model_usage_conversation ON agent_model_usage(conversation_id, created_at);
      CREATE INDEX idx_chat_attachments_conversation_id ON chat_attachments(conversation_id);
    ${EXAM_SCHEMA}
`

export const MIGRATE_V1_V2 = `
ALTER TABLE agent_chat_events RENAME TO old_agent_chat_events;
DROP INDEX idx_agent_chat_events_conversation;
${CHAT_EVENTS_V2}
INSERT INTO agent_chat_events SELECT * FROM old_agent_chat_events;
DROP TABLE old_agent_chat_events;
CREATE INDEX idx_agent_chat_events_conversation ON agent_chat_events(conversation_id, seq);
ALTER TABLE agent_model_usage RENAME TO old_agent_model_usage;
DROP INDEX idx_agent_model_usage_conversation;
${MODEL_USAGE_V2}
INSERT INTO agent_model_usage SELECT * FROM old_agent_model_usage;
DROP TABLE old_agent_model_usage;
CREATE INDEX idx_agent_model_usage_conversation ON agent_model_usage(conversation_id, created_at);
${EXAM_SCHEMA}
`
