// Test helper: a passing nightly sandbox conformance status (pump/breaker.mjs), checked at `at` (ms).
export function greenStatus(at) {
  return {
    format: 'isokron-sandbox-conformance/1', ok: true, selftest: 'pass', mutations: 'pass', result: 'success',
    checked_at: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: 1, run_attempt: 1,
    run_url: 'https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/1', sandbox_sha: 'a'.repeat(40),
    runner_image: 'ubuntu24/20261117.1', kernel: '6.11.0-1018-azure', docker: '28.0.4', gvisor_release: '20261116.0', runsc_version: 'release-20261116.0',
  };
}
