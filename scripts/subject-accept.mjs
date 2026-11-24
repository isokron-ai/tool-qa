#!/usr/bin/env node
// Accept the binding of a subject in id conflict (R-SUBJ-16).
//
//   node scripts/subject-accept.mjs <subject key> [--state state/state.sqlite]
//
// A subject is in conflict when a lookup answered a repository the guards
// would not bind (an id answering another creation time, or a repository
// created after the subject was first seen). Once a person has checked the
// repository is the right one, this marks the conflict accepted on a pulled
// copy of the state: the next pump run looks the subject up again and takes
// that answer as its binding, and the `subject-ids` amber clears. Only an id
// another subject holds is still refused. Run it with the pump paused, then
// push the state (docs/OPERATIONS.md, "Subject ids").

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openState } from '../state/db.mjs';

/** @returns {{ok: boolean, why?: string}} */
export function acceptConflict({ file, key, now = Date.now() }) {
  const db = openState(file);
  try {
    return db.acceptIdentityConflict(key, { now });
  } finally {
    db.close();
  }
}

export function main(argv = process.argv.slice(2), out = (l) => process.stdout.write(`${l}\n`)) {
  let file = 'state/state.sqlite';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') file = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1 || !file) {
    out('usage: node scripts/subject-accept.mjs <subject key> [--state state/state.sqlite]');
    return 2;
  }
  const r = acceptConflict({ file, key: rest[0] });
  out(r.ok ? `accepted: ${rest[0]} is looked up again by the next pump run and bound to its answer` : `not accepted: ${r.why}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
