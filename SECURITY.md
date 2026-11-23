# Security policy

## Reporting a problem

Please report security problems privately, through GitHub's private
vulnerability reporting on this repository:
**Security → Report a vulnerability** (a draft security advisory).
Don't open a public issue or pull request for a security problem.

Tell us what you found, how to reproduce it, and what an attacker could do with
it. We'll acknowledge the report, keep you updated while we fix it, and credit
you in the advisory if you want that.

## In scope

- The workflows in `.github/workflows/`, including the reusable
  `lint-workflows.yml`: anything that lets untrusted input run code in a
  trusted job, widens a token's permissions, or reads a secret.
- The kill switches (`scripts/guard.mjs`): any way to make the loop run when
  `LOOP_ENABLED` is not `true`, when it is paused, or with more slots than
  `LOOP_SLOTS` allows.
- The state store (`state/`) and `scripts/state-asset.mjs`: forged or late
  results being accepted (for example a stale fencing token winning), state
  corruption, or the token leaking into logs or to another host.
- The workflow policy check (`scripts/check-workflows.mjs`): a workflow that
  breaks a rule but passes the check.
- Anything that lets code from a tested server escape a worker's sandbox or
  reach this repository.

## Out of scope

- Bugs in the third-party MCP servers we test. Please report those to their
  maintainers.
- Findings that need a compromised GitHub account with admin rights on this
  repository.
- Denial of service against GitHub itself.
