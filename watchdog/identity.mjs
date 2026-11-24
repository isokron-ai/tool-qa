// The watchdog's `subject-ids` item (loop upgrade #15, R-SUBJ-13): what the
// pump's last subject id pass (pump/identity.mjs) left in kv pump.identity.
//
//   red    a pass stopped on a mass of NOT_FOUND answers and no batch has been
//          believed since (its token or permissions, most likely: nothing
//          was marked gone, the lookups are retried hourly), or more than 5 and more than 20% of the active
//          subjects are marked gone (not dispatched)
//   amber  any subject in id conflict (an id answering another creation time,
//          or a newcomer on a subject's old name): look at it by hand
//   green  otherwise, with the gone, conflict and merged counts
//   off    the lookups are switched off (LANE_SUBJECT_IDS_ENABLED; the pump
//          records it in kv pump.identity)
// Not shown before the first pass.

import { MASS_NOT_FOUND } from '../pump/identity.mjs';

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function identityCheck(ids) {
  if (!ids || typeof ids !== 'object') return null;
  const gone = n(ids.gone);
  const conflicts = n(ids.conflicts);
  const merged = n(ids.merged);
  const active = n(ids.active);
  const counts = `${gone} not found, ${conflicts} in conflict, ${merged} merged of ${active} active`;
  const base = { id: 'subject-ids', at: ids.at };
  if (ids.off === true) return { ...base, status: 'off', summary: `the subject id lookups are switched off (LANE_SUBJECT_IDS_ENABLED); ids already found are still used (${counts})` };
  // mass_not_found_at stays set until a batch is believed again (R-SUBJ-14).
  if (ids.stopped === 'mass_not_found' || ids.mass_not_found_at) {
    return { ...base, status: 'red', summary: `a subject id pass got NOT_FOUND for most of a batch${ids.mass_not_found_at ? ` at ${ids.mass_not_found_at}` : ''} and none has been believed since${ids.error ? ` (${String(ids.error).slice(0, 80)})` : ''}: check the pump's GITHUB_TOKEN; nothing was marked gone (${counts})` };
  }
  if (gone > MASS_NOT_FOUND.min && gone > MASS_NOT_FOUND.share * active) {
    return { ...base, status: 'red', summary: `${gone} subjects are marked gone and not dispatched (${counts}); see docs/OPERATIONS.md, "Subject ids"` };
  }
  if (conflicts > 0) {
    return { ...base, status: 'amber', summary: `${conflicts} subject(s) in id conflict: check subject_events by hand (${counts})` };
  }
  return { ...base, status: 'green', summary: `subject ids: ${counts}` };
}
