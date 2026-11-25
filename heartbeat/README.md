# Loop heartbeat

A Cloudflare Worker that restarts the loop when GitHub's own mechanisms don't. Every 5 minutes it checks `pump.yml`
and `watchdog.yml` in isokron-ai/tool-qa. It dispatches a workflow that has nothing queued or running and whose newest
run started too long ago: 15 minutes for the pump, 40 for the watchdog.

**Why it exists.** On 25 Nov 2026 a GitHub outage broke the pump's self-dispatch chain, and the `*/30` schedule fallback
didn't fire after recovery. GitHub's scheduled runs are unreliable under load: that week the `*/15` schedules ran every
5–9 hours. This Worker doesn't depend on GitHub's scheduler.

**Safety.**
- **Kill switches.** It dispatches nothing while tool-qa's `LOOP_ENABLED` variable is not `true`, while
  `HEARTBEAT_ENABLED` (in `wrangler.toml`) is not `true`, or when it can't read either.
- **No route.** It only runs on its cron trigger, and has no `workers.dev` URL.
- **Narrow token.** `GH_TOKEN` is a fine-grained token for isokron-ai/tool-qa only. It has **Actions: read and
  write** and **Variables: read**, nothing else.
- **Duplicate dispatches are harmless.** Both workflows run in a concurrency group with `cancel-in-progress: false`.

**Cost.** It makes 288 runs a day, each a few GitHub API calls. That's well inside the Workers free plan.

## Deploy (owner)

1. Create a fine-grained token on GitHub (Settings → Developer settings → Fine-grained tokens):
   - Resource owner: isokron-ai
   - Repository access: only isokron-ai/tool-qa
   - Repository permissions: Actions (read and write) and Variables (read only)
   - Expiry: 1 year. Put the renewal date in the runbook.
2. In this folder, run `npx wrangler@4 login` to sign in to Cloudflare.
3. Run `npx wrangler@4 secret put GH_TOKEN` and paste the token. It's stored only as a Worker secret.
4. Run `npx wrangler@4 deploy`.
5. Watch the logs with `npx wrangler@4 tail`. Within 5 minutes you should see `heartbeat: pump.yml: ok (...)` lines.

**To stop it:** set `HEARTBEAT_ENABLED = "false"` and redeploy, or run `npx wrangler@4 delete`.
