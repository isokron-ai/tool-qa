// Rejection reason codes, in four plain classes for the public ingest ring.
//
// The raw codes never leave the pump: the live snapshot shows a rejection only
// as one of CLASSES, and never against a server (live/build.mjs). Unknown
// codes fall into worker_output, so a new code can never be published raw.
//
// Every code the source can record is listed here explicitly;
// live/test/classes.test.mjs reads state/db.mjs and ingest/*.mjs and fails on
// any code that is missing, so a new reason has to be placed on purpose.
//
// Quarantines (secret_scan, and any result whose outcome is 'quarantined')
// are not a class: they emit no public event of any kind and count only in
// the snapshot's quarantined_daily total (live/build.mjs).

export const CLASSES = Object.freeze(['lease', 'integrity', 'worker_output', 'infra']);

/** The class unknown codes fall into. */
export const DEFAULT_CLASS = 'worker_output';

/** Reasons that quarantine a result: never public, in any form. */
export const QUARANTINE_REASONS = Object.freeze(['secret_scan']);

const TABLE = {
  // lease: the fence or lease no longer covers the result (state/db.mjs checkFence,
  // recordResult, ingest/ledger.mjs).
  stale_fence: 'lease',
  lease_expired: 'lease',
  no_lease: 'lease',
  holder_mismatch: 'lease',
  lease_released: 'lease',
  unknown_fence: 'lease',
  fence_mismatch: 'lease',
  duplicate_result: 'lease',

  // integrity: identity of the attempt, the run and the bundle; forgery
  // controls and the manifest (ingest/forgery.mjs, analyze.mjs PROBLEM_ORDER,
  // ingest.mjs checkRun and the ledger checks).
  unknown_attempt: 'integrity',
  unknown_run_key: 'integrity',
  ledger_repo_mismatch: 'integrity',
  ledger_run_mismatch: 'integrity',
  run_repo_mismatch: 'integrity',
  run_workflow_mismatch: 'integrity',
  run_event_mismatch: 'integrity',
  run_sha_mismatch: 'integrity',
  artifact_run_mismatch: 'integrity',
  decrypt_failed: 'integrity',
  attempt_mismatch: 'integrity',
  run_key_mismatch: 'integrity',
  workflow_repo_mismatch: 'integrity',
  workflow_file_mismatch: 'integrity',
  workflow_sha_mismatch: 'integrity',
  run_id_mismatch: 'integrity',
  run_attempt_mismatch: 'integrity',
  unlisted_file: 'integrity',
  missing_file: 'integrity',
  size_mismatch: 'integrity',
  digest_mismatch: 'integrity',
  forgery_control_injected: 'integrity',
  forgery_marker_leaked: 'integrity',
  foreign_identity_claim: 'integrity',
  control_output_in_raw: 'integrity',
  control_failed: 'integrity',
  control_missing: 'integrity',
  forgery_control_unverified: 'integrity',
  no_manifest: 'integrity',
  manifest_not_json: 'integrity',
  manifest_invalid: 'integrity',

  // worker_output: the bundle, the artifact and the registry observations
  // (analyze.mjs, ingest.mjs, ingest/registry.mjs), and the generic refusals.
  bad_bundle: 'worker_output',
  file_too_large: 'worker_output',
  bundle_too_large: 'worker_output',
  bad_container: 'worker_output',
  no_artifact: 'worker_output',
  duplicate_artifact: 'worker_output',
  artifact_too_large: 'worker_output',
  observation_format: 'worker_output',
  undeclared_field: 'worker_output',
  deprecated_field: 'worker_output',
  field_type: 'worker_output',
  rejected_by_ingest: 'worker_output',
  ledger_refused: 'worker_output',

  // infra: our runner, GitHub or a third party, not the worker's output.
  ingest_timeout: 'infra',
  ingest_error: 'infra',
  artifact_expired: 'infra',
  run_not_found: 'infra',
  run_not_completed: 'infra',
  retry_later: 'infra',
  retry_throttled: 'infra',
};

/** Raw reason code -> class, frozen. Read-only: use classOf(). */
export const REASON_CLASSES = Object.freeze({ ...TABLE });

/** The public class of a raw rejection reason; unknown or missing codes are worker_output. */
export function classOf(reason) {
  return typeof reason === 'string' && Object.hasOwn(REASON_CLASSES, reason) ? REASON_CLASSES[reason] : DEFAULT_CLASS;
}

/** Whether a recorded result is a quarantine (never public). */
export function isQuarantine({ reason = null, outcome = null } = {}) {
  return outcome === 'quarantined' || (typeof reason === 'string' && QUARANTINE_REASONS.includes(reason));
}
