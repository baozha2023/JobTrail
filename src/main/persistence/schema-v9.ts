import { SCHEMA_V8 } from './schema-v8'

// This SQL is the versioned source of truth for the immutable dictionary.
// Neither startup nor catalog synchronization repairs or reseeds existing rows.
export const MIGRATE_V8_V9 = `
CREATE TABLE company_natures (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL UNIQUE CHECK(typeof(sort_order) = 'integer' AND sort_order > 0)
);
INSERT INTO company_natures (code, name, sort_order) VALUES
  ('state_owned', '国有企业', 1),
  ('private', '民营企业', 2),
  ('foreign_invested', '外商投资企业', 3),
  ('public_institution', '事业单位', 4),
  ('social_organization', '社会组织', 5),
  ('other', '其他', 6);
ALTER TABLE companies ADD COLUMN company_nature TEXT DEFAULT NULL
  CHECK(company_nature IS NULL OR company_nature IN (
    'state_owned', 'private', 'foreign_invested', 'public_institution', 'social_organization', 'other'
  ));
ALTER TABLE exam_questions ADD COLUMN default_answer TEXT DEFAULT NULL
  CHECK(default_answer IS NULL OR (
    typeof(default_answer) = 'text'
    AND length(trim(default_answer)) > 0
    AND length(default_answer) <= 12000
  ));
`

export const SCHEMA_V9 = SCHEMA_V8 + MIGRATE_V8_V9
