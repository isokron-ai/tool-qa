// MCP matcher shared by every H2 source. Pure functions, no I/O.

const KEYWORDS = new Set(['mcp', 'modelcontextprotocol']);

/** Split a package name or module path into lowercase alphanumeric tokens. */
export function tokens(name) {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when the name contains `mcp` as a whole token (mcp-server, @x/mcp, foo_mcp_bar). */
export function nameMatches(name) {
  return tokens(name).includes('mcp');
}

/** True when a keyword list contains `mcp` or `modelcontextprotocol` (case-insensitive). */
export function keywordsMatch(keywords) {
  const list = Array.isArray(keywords) ? keywords : typeof keywords === 'string' ? keywords.split(/[,\s]+/) : [];
  return list.some((k) => KEYWORDS.has(String(k).trim().toLowerCase()));
}

/** True when a description mentions `mcp` as a token or "model context protocol". */
export function descriptionMatches(description) {
  const d = String(description ?? '');
  return tokens(d).includes('mcp') || /model[\s-]+context[\s-]+protocol/i.test(d);
}

/**
 * Full matcher. Rule: name token `mcp`, or keyword `mcp`/`modelcontextprotocol`,
 * or the description names MCP. Returns the reasons that matched ([] = no match).
 */
export function matchReasons({ name, keywords, description } = {}) {
  const reasons = [];
  if (nameMatches(name)) reasons.push('name');
  if (keywordsMatch(keywords)) reasons.push('keyword');
  if (descriptionMatches(description)) reasons.push('description');
  return reasons;
}

export function matchesMcp(pkg) {
  return matchReasons(pkg).length > 0;
}
