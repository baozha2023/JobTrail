import { SCHEMA_V3 } from './schema-v3'
// V4 targets the unreleased v2.0.0: correct this DDL and its test baseline in place,
// without intermediate compatibility or migrations. Freeze it on official release.
const platformCheck = "'boss','liepin','zhilian','wuyou'"
const sourceStateCheck =
  "'queued','running','completed','partial','login_required','session_expired','challenge','unsupported_city','scope_unverified','parse_error','timeout','network_error','cancelled','interrupted'"
const nonnegative = (name: string) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=0)`
const positive = (name: string) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>0)`
export const MIGRATE_V3_V4 = `
CREATE TABLE discovery_jobs (
  id TEXT PRIMARY KEY NOT NULL, platform TEXT NOT NULL CHECK(platform IN (${platformCheck})),
  identity TEXT NOT NULL CHECK(length(identity)>0), url TEXT NOT NULL,
  ${nonnegative('created_at')}, ${positive('current_observation_id')},
  duplicate_fingerprint TEXT, UNIQUE(platform,identity)
);
CREATE INDEX idx_discovery_job_duplicate ON discovery_jobs(duplicate_fingerprint,platform);
CREATE INDEX idx_discovery_job_current ON discovery_jobs(current_observation_id);
CREATE TABLE discovery_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=131072), ${nonnegative('observed_at')}
);
CREATE INDEX idx_discovery_observation_job ON discovery_observations(job_id,id DESC);
CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)>0), query TEXT NOT NULL CHECK(json_valid(query)),
  state TEXT NOT NULL CHECK(state IN('queued','running','completed','partial','cancelled','interrupted')),
  ${nonnegative('created_at')}, ${nonnegative('updated_at')}, CHECK(updated_at>=created_at)
);
CREATE INDEX idx_discovery_runs_created ON discovery_runs(created_at DESC,id);
CREATE TABLE discovery_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)>0), run_id TEXT NOT NULL
);
CREATE INDEX idx_discovery_requests_run ON discovery_requests(run_id);
CREATE TABLE discovery_sources (
  run_id TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN (${platformCheck})),
  state TEXT NOT NULL CHECK(state IN (${sourceStateCheck})),
  ${['count', 'batches', 'source_page', 'raw_count', 'valid_count', 'duplicate_count', 'rejected_count', 'excluded_range', 'excluded_day', 'excluded_hour', 'excluded_foreign', 'excluded_unknown', 'generation'].map(nonnegative).join(',\n  ')},
  cursor TEXT, remote TEXT NOT NULL CHECK(json_valid(remote)), message TEXT NOT NULL,
  cached_at INTEGER CHECK(cached_at IS NULL OR (typeof(cached_at)='integer' AND cached_at>=0)), PRIMARY KEY(run_id,platform)
);
CREATE TABLE discovery_results (
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ${positive('observation_id')}, ${nonnegative('relevance')}, PRIMARY KEY(run_id,job_id)
);
CREATE INDEX idx_discovery_results_observation ON discovery_results(observation_id);
CREATE INDEX idx_discovery_results_job ON discovery_results(job_id);
CREATE TABLE discovery_views (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL,
  sort TEXT NOT NULL CHECK(sort IN ('relevance','salary','discovered')), ${nonnegative('created_at')}
);
CREATE INDEX idx_discovery_views_run ON discovery_views(run_id);
CREATE TABLE discovery_view_items (
  view_id TEXT NOT NULL, ${positive('ordinal')},
  job_id TEXT NOT NULL, ${positive('observation_id')},
  PRIMARY KEY(view_id,job_id), UNIQUE(view_id,ordinal)
);
CREATE INDEX idx_discovery_view_job ON discovery_view_items(job_id);
CREATE INDEX idx_discovery_view_observation ON discovery_view_items(observation_id);
CREATE TABLE discovery_platforms (
  platform TEXT PRIMARY KEY NOT NULL CHECK(platform IN (${platformCheck})), payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE discovery_saved (
  job_id TEXT PRIMARY KEY NOT NULL,
  ${positive('opportunity_id')},
  ${positive('observation_id')}, ${nonnegative('created_at')}
);
CREATE INDEX idx_discovery_saved_opportunity ON discovery_saved(opportunity_id);
CREATE INDEX idx_discovery_saved_observation ON discovery_saved(observation_id);
`
export const SCHEMA_V4 = SCHEMA_V3 + MIGRATE_V3_V4
