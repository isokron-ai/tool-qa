// Rejection reason codes, in four plain classes for the public ingest ring.
//
// The raw codes never leave the pump: the live snapshot shows rejections only
// as daily per-lane totals of CLASSES, never per item or per server. Unknown
// codes fall into worker_output, so a new code can never be published raw.
//
// Every code the source can record is listed here explicitly;
// live/test/classes.test.mjs reads state/db.mjs and ingest/*.mjs and fails on
// any code that is missing, so a new reason has to be placed on purpose.
//
// Quarantines (secret_scan, and any result whose outcome is 'quarantined')
// have no class of their own: like every rejection they emit no public event,
// and in the daily totals they count as integrity (dailyClassOf), so nothing
// public tells them apart (live/build.mjs, R-LIVE-25).

export const CLASSES = Object.freeze(['lease', 'integrity', 'worker_output', 'infra']);

/**
 * Classes that are not on the public ring. `control_miss`: a T0 control lane's control did not hold (a seeded defect
 * missed, a known-good build failed; pump/controls.mjs): a lead against OUR tool, fault `tool`, never a forgery. It must
 * reach the check-in and lead ranking as such. In the public daily totals it counts as integrity, so the public format
 * does not change (dailyClassOf).
 */
export const INTERNAL_CLASSES = Object.freeze(['control_miss']);

/** The fault side of a class that names one: control_miss is the tool's. */
export const CLASS_FAULT = Object.freeze({ control_miss: 'tool' });

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
  // A T0 control lane's own control did not hold: our tool's miss, not an integrity incident (R-CTL-10).
  control_failed: 'control_miss',
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
  // Version pins (R-PIN-01, pump/pins.mjs): the worker's manifest reports, or
  // fails to prove, other tool or probe versions than the run_key names.
  pin_mismatch: 'worker_output',
  pin_unverified: 'worker_output',

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

/**
 * The class a rejection counts in for the public daily totals (ring_daily):
 * its class, and integrity for a quarantine, so no public count tells a
 * quarantine apart from another rejection (R-LIVE-25).
 */
export function dailyClassOf({ reason = null, outcome = null } = {}) {
  if (isQuarantine({ reason, outcome })) return 'integrity';
  const c = classOf(reason);
  return INTERNAL_CLASSES.includes(c) ? 'integrity' : c;
}
