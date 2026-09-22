// robots.txt support.
//
// We only read endpoints shops publish deliberately, but "published" is not
// the same as "you are welcome to automate against it", and robots.txt is how
// a site says so. Every ingestion request goes through isAllowed() first.
//
// Deliberately a small subset of the spec: User-agent grouping, Allow,
// Disallow and longest-match-wins precedence. No Crawl-delay (http.js already
// throttles harder than most sites ask for) and no wildcard-heavy edge cases.

const { fetchText, USER_AGENT } = require('./http');

const OUR_TOKEN = USER_AGENT.split('/')[0].toLowerCase(); // "local-shop-design-app"

// origin -> rule set. A host is fetched once per process.
const cache = new Map();

function parseRobots(text) {
  const groups = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      // Consecutive User-agent lines share one rule block.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }

  return groups;
}

function selectGroup(groups) {
  // A group naming us beats the catch-all, which is the whole point of
  // identifying ourselves in the User-Agent.
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && OUR_TOKEN.includes(a)));
  if (named) return named;
  return groups.find((g) => g.agents.includes('*')) || null;
}

// Escape everything the robots spec treats literally, then re-enable '*'.
const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

function pathMatches(pattern, pathname) {
  if (pattern === '') return false; // "Disallow:" with no value means allow all

  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(REGEX_SPECIALS, '\\$&').replace(/\*/g, '.*');
  const source = endAnchored ? `^${escaped}$` : `^${escaped}`;

  try {
    return new RegExp(source).test(pathname);
  } catch {
    return false;
  }
}

async function loadRules(origin) {
  if (cache.has(origin)) return cache.get(origin);

  const text = await fetchText(`${origin}/robots.txt`, 'text/plain');
  // No robots.txt, or an unreachable one, conventionally means "no rules".
  const rules = text ? selectGroup(parseRobots(text)) : null;
  cache.set(origin, rules);
  return rules;
}

/**
 * True when robots.txt permits us to fetch this URL. Longest matching rule
 * wins; Allow beats Disallow at equal length, per Google's convention.
 */
async function isAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const group = await loadRules(parsed.origin);
  if (!group) return true;

  let decision = true;
  let bestLength = -1;

  for (const rule of group.rules) {
    if (!pathMatches(rule.path, parsed.pathname)) continue;
    if (rule.path.length > bestLength || (rule.path.length === bestLength && rule.allow)) {
      decision = rule.allow;
      bestLength = rule.path.length;
    }
  }

  return decision;
}

module.exports = { isAllowed, parseRobots, pathMatches, selectGroup };
