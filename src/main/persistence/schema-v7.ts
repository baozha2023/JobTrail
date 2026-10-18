import { SCHEMA_V6 } from './schema-v6'

// V7: extend platform CHECKs; preserve IDs, observations and references.
// The migration runner owns the IMMEDIATE transaction and per-version validation.
export const MIGRATE_V6_V7 = `
CREATE TABLE discovery_jobs_v7 (
  id TEXT PRIMARY KEY NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('boss','liepin','zhilian','wuyou','iguopin','shixiseng','yupao','nowcoder')),
  identity TEXT NOT NULL CHECK(length(identity)>0), url TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  current_observation_id INTEGER NOT NULL CHECK(typeof(current_observation_id)='integer' AND current_observation_id>0),
  duplicate_fingerprint TEXT, UNIQUE(platform,identity)
);
INSERT INTO discovery_jobs_v7 (id, platform, identity, url, created_at, current_observation_id, duplicate_fingerprint)
SELECT id, platform, identity, url, created_at, current_observation_id, duplicate_fingerprint FROM discovery_jobs;
DROP TABLE discovery_jobs;
ALTER TABLE discovery_jobs_v7 RENAME TO discovery_jobs;
CREATE INDEX idx_discovery_job_duplicate ON discovery_jobs(duplicate_fingerprint,platform);
CREATE INDEX idx_discovery_job_current ON discovery_jobs(current_observation_id);
CREATE TABLE discovery_sources_v7 (
  run_id TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('boss','liepin','zhilian','wuyou','iguopin','shixiseng','yupao','nowcoder')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','partial','login_required','session_expired','challenge','unsupported_city','scope_unverified','parse_error','timeout','network_error','cancelled','interrupted')),
  count INTEGER NOT NULL CHECK(typeof(count)='integer' AND count>=0),
  batches INTEGER NOT NULL CHECK(typeof(batches)='integer' AND batches>=0),
  source_page INTEGER NOT NULL CHECK(typeof(source_page)='integer' AND source_page>=0),
  raw_count INTEGER NOT NULL CHECK(typeof(raw_count)='integer' AND raw_count>=0),
  valid_count INTEGER NOT NULL CHECK(typeof(valid_count)='integer' AND valid_count>=0),
  duplicate_count INTEGER NOT NULL CHECK(typeof(duplicate_count)='integer' AND duplicate_count>=0),
  rejected_count INTEGER NOT NULL CHECK(typeof(rejected_count)='integer' AND rejected_count>=0),
  excluded_range INTEGER NOT NULL CHECK(typeof(excluded_range)='integer' AND excluded_range>=0),
  excluded_day INTEGER NOT NULL CHECK(typeof(excluded_day)='integer' AND excluded_day>=0),
  excluded_hour INTEGER NOT NULL CHECK(typeof(excluded_hour)='integer' AND excluded_hour>=0),
  excluded_foreign INTEGER NOT NULL CHECK(typeof(excluded_foreign)='integer' AND excluded_foreign>=0),
  excluded_unknown INTEGER NOT NULL CHECK(typeof(excluded_unknown)='integer' AND excluded_unknown>=0),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0),
  cursor TEXT, remote TEXT NOT NULL CHECK(json_valid(remote)), message TEXT NOT NULL,
  cached_at INTEGER CHECK(cached_at IS NULL OR (typeof(cached_at)='integer' AND cached_at>=0)), PRIMARY KEY(run_id,platform)
);
INSERT INTO discovery_sources_v7 (run_id, platform, state, count, batches, source_page, raw_count, valid_count, duplicate_count, rejected_count, excluded_range, excluded_day, excluded_hour, excluded_foreign, excluded_unknown, generation, cursor, remote, message, cached_at)
SELECT run_id, platform, state, count, batches, source_page, raw_count, valid_count, duplicate_count, rejected_count, excluded_range, excluded_day, excluded_hour, excluded_foreign, excluded_unknown, generation, cursor, remote, message, cached_at FROM discovery_sources;
DROP TABLE discovery_sources;
ALTER TABLE discovery_sources_v7 RENAME TO discovery_sources;
CREATE TABLE discovery_platforms_v7 (
  platform TEXT PRIMARY KEY NOT NULL CHECK(platform IN ('boss','liepin','zhilian','wuyou','iguopin','shixiseng','yupao','nowcoder')), payload TEXT NOT NULL CHECK(json_valid(payload))
);
INSERT INTO discovery_platforms_v7 (platform, payload)
SELECT platform, payload FROM discovery_platforms;
DROP TABLE discovery_platforms;
ALTER TABLE discovery_platforms_v7 RENAME TO discovery_platforms;
`
export const SCHEMA_V7 = SCHEMA_V6 + MIGRATE_V6_V7
