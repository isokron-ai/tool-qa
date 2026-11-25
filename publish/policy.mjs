// What may be published, decided from the field registry in isokron-ai/mcp-results
// (fields/registry.yaml), field by field. Pure functions.
//
// Registry classes (see the header of the registry):
//   P, P-s   public for every server, once the result was accepted. Published.
//   P-h, B   public only after a person has checked or confirmed it. No
//            per-record confirmation exists yet, so they are not published.
//   P-t      text written by the server's author. Published word for word only
//            where the licence allows it; no such decision exists yet.
//   PA       aggregates only. Never published per server.
//   X        private for good.
//   S, M     an actual security issue, or evidence of malicious behaviour.
//            Never published, not even as a count. A result that holds one is
//            held whole (HOLD_CLASSES); nothing is printed or counted about it.
//
// A field is published only when its registry entry is `active`.

export const PUBLISH_CLASSES = Object.freeze(['P', 'P-s']);
/** A result carrying a field of one of these classes is held whole, silently. */
export const HOLD_CLASSES = Object.freeze(['S', 'M']);
/** Not published, but not secret: counted per class in the manifest. */
export const WITHHELD_CLASSES = Object.freeze(['P-h', 'P-t', 'PA', 'B', 'X']);

/**
 * @param {Map<string, object>} fields  parsed registry (ingest/registry.mjs parseRegistry().fields)
 * @param {string} id
 * @returns {{decision: 'publish'|'hold'|'withhold', reason: string, entry?: object}}
 *   hold: the whole result is held, silently; withhold: this field is left out
 */
export function decideField(fields, id) {
  const entry = fields.get(id);
  if (!entry) return { decision: 'withhold', reason: 'undeclared' };
  // The class is checked before the status: a planned or deprecated S field that
  // shows up in a bundle is still a security-class value.
  if (HOLD_CLASSES.includes(entry.class)) return { decision: 'hold', reason: 'security_class', entry };
  if (entry.status !== 'active') return { decision: 'withhold', reason: `status_${entry.status}`, entry };
  if (PUBLISH_CLASSES.includes(entry.class)) return { decision: 'publish', reason: 'ok', entry };
  if (WITHHELD_CLASSES.includes(entry.class)) return { decision: 'withhold', reason: `class_${entry.class}`, entry };
  // An unknown class is never published.
  return { decision: 'withhold', reason: 'class_unknown', entry };
}

/** How a result's coverage state reads, in plain words. Never "failed". */
export const ATTRIBUTION = Object.freeze({
  assessed: 'assessed',
  unassessed_tool: 'our_limit',
  unassessed_unknown: 'not_stated',
  unassessed_infra: 'infrastructure',
  subject: 'server_condition',
  excluded: 'our_policy',
});
