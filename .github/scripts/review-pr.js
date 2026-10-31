'use strict';

// Automated review of contributor pull requests against CONTRIBUTING.md.
// Posts (or updates) a single recommendation comment. It never closes,
// merges, labels, or approves a pull request.

const fs = require('fs');
const path = require('path');

const MAINTAINER = 'mjawaids';
const MARKER = '<!-- pr-guidelines-review -->';
const MIN_DOMAIN_AGE_MONTHS = 12;
const NETWORK_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (compatible; awesome-startup-tools-review/1.0)';

// Hosts whose links point at repositories rather than a product's own domain.
const REPO_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

// Platform subdomains that do not count as a product's own custom domain.
const PLATFORM_SUFFIXES = [
  'github.io', 'gitlab.io', 'bitbucket.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com',
  'onrender.com', 'fly.dev', 'railway.app', 'replit.app', 'repl.co',
  'glitch.me', 'surge.sh', 'wixsite.com', 'webflow.io', 'framer.website',
  'framer.app', 'notion.site', 'carrd.co', 'wordpress.com', 'blogspot.com',
  'substack.com', 'gitbook.io', 'streamlit.app', 'lovable.app',
  'bubbleapps.io', 'hf.space', 'azurewebsites.net', 'amplifyapp.com',
];

const TRACKING_PARAMS = new Set([
  'ref', 'ref_src', 'ref_url', 'referrer', 'referral', 'via', 'partner',
  'fbclid', 'gclid', 'msclkid', 'yclid', 'mc_cid', 'mc_eid', 'igshid',
]);
const TRACKING_PREFIXES = ['utm_', 'aff'];

const ENTRY_FORMAT = /^- (\S.*?) - (https?:\/\/\S+)$/;
const LIST_ITEM = /^\s*[-*+] /;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const URL_ANY = /https?:\/\/[^\s<>()\[\]"'`,]+/g;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parsePatch(patch) {
  const added = [];
  const removed = [];
  for (const line of (patch || '').split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  const nonBlank = (l) => l.trim() !== '';
  return { added: added.filter(nonBlank), removed: removed.filter(nonBlank) };
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function entryName(line) {
  const m = line.trimEnd().match(ENTRY_FORMAT);
  if (m) return m[1].trim();
  const loose = line.replace(LIST_ITEM, '').split(/\s+-\s+|\s+https?:\/\/|\t/)[0];
  return loose.replace(/^\[(.*?)\].*$/, '$1').trim();
}

function firstUrl(line) {
  const m = line.match(URL_ANY);
  return m ? m[0].replace(/[.,;:]+$/, '') : null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '').toLowerCase();
    return host + p;
  } catch {
    return null;
  }
}

function isPlatformHost(host) {
  return PLATFORM_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

function readmeEntries(readme) {
  const entries = [];
  for (const line of readme.split('\n')) {
    if (!LIST_ITEM.test(line)) continue;
    const urls = line.match(URL_ANY) || [];
    entries.push({ line, name: entryName(line), urls: urls.map((u) => u.replace(/[.,;:]+$/, '')) });
  }
  return entries;
}

function headings(readme) {
  const out = [];
  readme.split('\n').forEach((line, index) => {
    const m = line.match(HEADING);
    if (m) out.push({ level: m[1].length, text: m[2], index });
  });
  return out;
}

function categoryOf(readme, entryLine) {
  const lines = readme.split('\n');
  const idx = lines.findIndex((l) => l.trimEnd() === entryLine.trimEnd());
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const m = lines[i].match(HEADING);
    if (m) return { level: m[1].length, text: m[2] };
  }
  return { level: 0, text: '' };
}

function monthsBetween(from, to) {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
    - (to.getDate() < from.getDate() ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Network lookups (injectable for tests)
// ---------------------------------------------------------------------------

async function rdapLookup(host) {
  const labels = host.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const domain = labels.slice(i).join('.');
    let res;
    try {
      res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        headers: { accept: 'application/rdap+json, application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, error: `RDAP lookup failed (${err.name || 'error'})` };
    }
    if (res.status === 404) continue;
    if (!res.ok) return { ok: false, error: `RDAP lookup returned HTTP ${res.status}` };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: 'RDAP response was not valid JSON' };
    }
    const reg = (data.events || []).find((e) => e.eventAction === 'registration');
    if (!reg || !reg.eventDate) return { ok: false, error: `no registration date in RDAP record for ${domain}` };
    return { ok: true, domain, registered: reg.eventDate };
  }
  return { ok: false, error: 'domain not found in RDAP (the TLD may not support RDAP)' };
}

async function siteCheck(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: true, status: res.status, finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : 'request failed' };
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array<{filename:string,status:string,patch?:string}>} input.files
 * @param {string} input.baseReadme  README.md on the base branch
 * @param {string|null} input.headReadme README.md at the PR head (null if unavailable)
 * @param {Date} [input.now]
 * @param {Function} [input.rdap]   async (host) => rdap result
 * @param {Function} [input.site]   async (url) => site check result
 */
async function analyze({ files, baseReadme, headReadme, now = new Date(), rdap = rdapLookup, site = siteCheck }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const result = { verdict: 'manual', entry: null, checks, domainFailed: false, notes: [] };

  // Files
  const otherFiles = files.filter((f) => f.filename !== 'README.md');
  const readmeFile = files.find((f) => f.filename === 'README.md');
  if (otherFiles.length === 0 && readmeFile) {
    add('Files changed', 'pass', 'Only `README.md` is changed');
  } else if (!readmeFile) {
    add('Files changed', 'fail', `\`README.md\` is not changed; changed: ${otherFiles.map((f) => code(f.filename)).join(', ')}`);
  } else {
    add('Files changed', 'fail', `Changes files other than \`README.md\`: ${otherFiles.map((f) => code(f.filename)).join(', ')}`);
  }

  if (!readmeFile) {
    result.notes.push('This pull request does not touch `README.md`, so it is not a tool submission.');
    return finalize(result);
  }
  if (readmeFile.patch === undefined) {
    add('Diff', 'warn', 'GitHub did not provide a diff for `README.md` (too large); review manually');
    return finalize(result);
  }

  const { added, removed } = parsePatch(readmeFile.patch);
  const addedItems = added.filter((l) => LIST_ITEM.test(l));
  const addedHeadings = added.filter((l) => HEADING.test(l));
  const addedOther = added.filter((l) => !LIST_ITEM.test(l) && !HEADING.test(l));
  const removedNames = new Set(removed.filter((l) => LIST_ITEM.test(l)).map((l) => normalizeName(entryName(l))));
  const newItems = addedItems.filter((l) => !removedNames.has(normalizeName(entryName(l))));
  const editedItems = addedItems.length - newItems.length;

  if (newItems.length === 0) {
    const parts = [];
    if (editedItems) parts.push(`${editedItems} edited entr${editedItems === 1 ? 'y' : 'ies'}`);
    const removedOnly = removed.filter((l) => LIST_ITEM.test(l)).length - editedItems;
    if (removedOnly > 0) parts.push(`${removedOnly} removed entr${removedOnly === 1 ? 'y' : 'ies'}`);
    if (addedHeadings.length) parts.push(`${addedHeadings.length} added heading(s)`);
    if (addedOther.length) parts.push(`${addedOther.length} other added line(s)`);
    add('New tool', 'warn', `No new tool added (${parts.join(', ') || 'no list changes'}); this is not a tool submission`);
    result.notes.push('No new tool entry was detected, so the inclusion criteria were not applied. Review the changes manually.');
    return finalize(result);
  }

  // One tool per PR
  const extraChanges = [];
  if (newItems.length > 1) extraChanges.push(`adds ${newItems.length} tools`);
  if (removed.length > 0) extraChanges.push(`removes or edits ${removed.length} existing line(s)`);
  if (addedHeadings.length > 0) extraChanges.push(`adds ${addedHeadings.length} heading(s)`);
  if (addedOther.length > 0) extraChanges.push(`adds ${addedOther.length} non-entry line(s)`);
  if (extraChanges.length === 0) {
    add('One tool per PR', 'pass', 'Adds exactly one tool and changes nothing else');
  } else {
    add('One tool per PR', 'fail', `Pull request ${extraChanges.join('; ')}. Submit one tool per pull request with no other changes`);
  }

  const line = newItems[0].trimEnd();
  const name = entryName(line);
  const url = firstUrl(line);
  result.entry = { line, name, url, category: null };
  if (newItems.length > 1) {
    result.notes.push(`Only the first added tool (${code(name)}) was checked in detail.`);
  }

  // Format
  const fm = line.match(ENTRY_FORMAT);
  if (fm && !/\t/.test(line) && /[()\[\]:|]/.test(fm[1])) {
    add('Format', 'fail', `Tool name ${code(fm[1])} appears to include a description. Use just the tool name: \`- Tool Name - https://url\``);
  } else if (fm && !/\t/.test(line)) {
    add('Format', 'pass', 'Matches `- Tool Name - https://url`');
  } else {
    add('Format', 'fail', `Entry must be \`- Tool Name - https://url\` with no description; got ${code(line)}`);
  }

  // Category
  const baseHeadingTexts = new Set(headings(baseReadme).map((h) => h.text));
  const cat = headReadme ? categoryOf(headReadme, line) : null;
  if (addedHeadings.length > 0) {
    add('Category', 'fail', `Adds new heading(s) ${addedHeadings.map((h) => code(h.trim())).join(', ')}. Place the tool in an existing category`);
  } else if (!cat) {
    add('Category', 'warn', 'Could not determine the category of the entry; check placement manually');
  } else if (cat.level <= 1) {
    add('Category', 'fail', 'Entry is not placed under a category heading');
  } else if (/featured|sponsor/i.test(cat.text)) {
    add('Category', 'fail', `Entry is placed in ${code(cat.text)}. Featured listings are not added by pull request; see SPONSORS.md`);
  } else if (!baseHeadingTexts.has(cat.text)) {
    add('Category', 'fail', `Category ${code(cat.text)} does not exist in the list`);
  } else {
    result.entry.category = cat.text;
    add('Category', 'pass', `Existing category ${code(cat.text)} (check that it is the most relevant one)`);
  }

  let parsed = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  if (!parsed) {
    add('Domain', 'fail', 'No valid URL found in the entry');
    result.domainFailed = true;
    return finalize(result);
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  // Domain
  if (REPO_HOSTS.includes(host)) {
    add('Domain', 'fail', `${code(host)} is a code repository link. Tools must be hosted on their own custom domain`);
    result.domainFailed = true;
  } else if (isPlatformHost(host)) {
    add('Domain', 'fail', `${code(host)} is a platform subdomain. Tools must be hosted on their own custom domain`);
    result.domainFailed = true;
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) {
    add('Domain', 'fail', `${code(host)} is not a custom domain`);
    result.domainFailed = true;
  } else {
    add('Domain', 'pass', `Custom domain ${code(host)}`);
  }

  // Tracking parameters
  const tracking = [...parsed.searchParams.keys()].filter((k) => {
    const key = k.toLowerCase();
    return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p));
  });
  if (tracking.length) {
    add('No tracking/referral', 'fail', `URL contains tracking or referral parameter(s): ${tracking.map(code).join(', ')}`);
  } else {
    add('No tracking/referral', 'pass', 'No tracking or referral parameters');
  }

  // Duplicates
  const existing = readmeEntries(baseReadme);
  const nName = normalizeName(name);
  const nUrl = normalizeUrl(url);
  const sameName = existing.find((e) => nName && normalizeName(e.name) === nName);
  const sameUrl = existing.find((e) => e.urls.some((u) => normalizeUrl(u) === nUrl));
  const sameHost = existing.find((e) => e.urls.some((u) => hostOf(u) === host));
  if (sameName || sameUrl) {
    const hit = sameName || sameUrl;
    add('Not a duplicate', 'fail', `Already listed: ${code(hit.line.trim())}`);
  } else if (sameHost) {
    add('Not a duplicate', 'warn', `Same domain as existing entry ${code(sameHost.line.trim())}; confirm it is a different product`);
  } else {
    add('Not a duplicate', 'pass', 'Not already in the list');
  }

  // Credibility proxy: domain age
  if (!result.domainFailed) {
    const r = await rdap(host);
    if (r && r.ok) {
      const registered = new Date(r.registered);
      const months = monthsBetween(registered, now);
      const date = registered.toISOString().slice(0, 10);
      if (months < MIN_DOMAIN_AGE_MONTHS) {
        add('Domain age', 'fail', `${code(r.domain)} was registered on ${date} (${months} month${months === 1 ? '' : 's'} ago). New or recently launched tools generally do not meet the credibility criterion`);
      } else {
        add('Domain age', 'pass', `${code(r.domain)} registered on ${date}`);
      }
    } else {
      add('Domain age', 'warn', `Could not determine domain age: ${r && r.error ? r.error : 'unknown error'}`);
    }
  }

  // Site reachability (informational only)
  const s = await site(url);
  if (!s || !s.ok) {
    add('Site reachable', 'warn', `Could not load the site (${s && s.error ? s.error : 'unknown error'}); some sites block automated requests`);
  } else {
    const finalHost = hostOf(s.finalUrl);
    if (finalHost && finalHost !== host && (isPlatformHost(finalHost) || REPO_HOSTS.includes(finalHost))) {
      add('Site reachable', 'warn', `Redirects to ${code(finalHost)}, which is not a custom domain`);
    } else if (s.status >= 400) {
      add('Site reachable', 'warn', `Site returned HTTP ${s.status}; some sites block automated requests`);
    } else {
      add('Site reachable', 'pass', `HTTP ${s.status}${finalHost && finalHost !== host ? ` (redirects to ${code(finalHost)})` : ''}`);
    }
  }

  return finalize(result);
}

function finalize(result) {
  if (result.entry) {
    result.verdict = result.checks.some((c) => c.status === 'fail') ? 'reject' : 'accept';
  } else {
    result.verdict = 'manual';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

function code(text) {
  const t = String(text).replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return '`' + t + '`';
}

const ICON = { pass: '✅', fail: '❌', warn: '⚠️' };

function buildComment(result, { author, repoUrl, branch }) {
  const contributing = `${repoUrl}/blob/${branch}/CONTRIBUTING.md`;
  const sponsors = `${repoUrl}/blob/${branch}/SPONSORS.md`;
  const failed = result.checks.filter((c) => c.status === 'fail').length;
  const out = [MARKER, '## Automated guidelines review', ''];

  if (result.verdict === 'reject') {
    out.push(`**Recommendation: ❌ Reject** (${failed} check${failed === 1 ? '' : 's'} failed against [CONTRIBUTING.md](${contributing}))`);
  } else if (result.verdict === 'accept') {
    out.push('**Recommendation: ✅ Accept, pending manual checks** (all automated checks passed)');
  } else {
    out.push('**Recommendation: ⚠️ Manual review needed** (not a single-tool submission)');
  }
  out.push('');

  if (result.entry) {
    const cat = result.entry.category ? ` in ${code(result.entry.category)}` : '';
    out.push(`**Entry:** ${code(result.entry.name)} → ${code(result.entry.url || 'no URL')}${cat}`, '');
  }

  out.push('| Check | Result | Details |', '|---|---|---|');
  for (const c of result.checks) out.push(`| ${c.name} | ${ICON[c.status]} | ${c.detail} |`);
  out.push('');

  for (const n of result.notes) out.push(`> ${n}`, '');

  if (result.entry) {
    out.push('**Verify manually:** credibility and track record (established, real-world usage, continued availability), and a permanent free plan or free tier (free trials do not qualify).', '');
  }
  out.push('<sub>Automated review for the maintainer. No action has been taken on this pull request; the maintainer makes the final decision. This comment updates when new commits are pushed.</sub>');

  if (result.verdict === 'reject') {
    out.push(
      '',
      '---',
      '',
      `Hi @${author}, thanks for your submission. This pull request does not appear to meet the [contribution guidelines](${contributing}) for the reasons listed above, so it is unlikely to be added to the curated list. The maintainer will review it and make the final decision.`,
      '',
      'If you would still like to put your product in front of the founders, indie hackers, and small teams who use this list, you can apply for a **featured listing**:',
      '',
      '- Open to any eligible product, including newer products that do not yet meet the curated list\'s track-record requirement',
      '- One line in the Featured section at the top of the README, with your product name, link, and a description of up to 15 words, labelled **Sponsored**',
      '- Limited to 5 featured listings at any time, on monthly, quarterly, or annual terms paid in advance',
      '- No pull request needed: email **support@ibexoft.com** with the subject line **Featured listing**, and include your product URL, company name, preferred term, and proposed one-line description',
      '',
    );
    if (result.domainFailed) {
      out.push('Please note that featured listings also require the product to be live and hosted on its own custom domain.', '');
    }
    out.push(`Featured listings are separate from the curated list. Payment does not influence pull request reviews, and inclusion in the curated list cannot be purchased. Eligibility and acceptance are at the maintainer's discretion. Full details are in [SPONSORS.md](${sponsors}).`);
  }

  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// GitHub Actions entry point
// ---------------------------------------------------------------------------

async function fetchHeadReadme(github, pr, owner, repo) {
  const attempts = [];
  if (pr.head.repo) attempts.push({ owner: pr.head.repo.owner.login, repo: pr.head.repo.name });
  attempts.push({ owner, repo });
  for (const a of attempts) {
    try {
      const { data } = await github.rest.repos.getContent({ ...a, path: 'README.md', ref: pr.head.sha });
      if (data && data.content) return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    } catch { /* try next */ }
  }
  return null;
}

async function run({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info('No pull request in event payload; nothing to do.');
    return;
  }
  if (String(pr.user.login).toLowerCase() === MAINTAINER.toLowerCase()) {
    core.info(`Pull request opened by maintainer ${MAINTAINER}; skipping.`);
    return;
  }

  const { owner, repo } = context.repo;
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const baseReadme = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
  const readmeChanged = files.some((f) => f.filename === 'README.md' && f.status !== 'removed');
  const headReadme = readmeChanged ? await fetchHeadReadme(github, pr, owner, repo) : null;

  const result = await analyze({ files, baseReadme, headReadme });
  const body = buildComment(result, {
    author: pr.user.login,
    repoUrl: `${context.serverUrl || 'https://github.com'}/${owner}/${repo}`,
    branch: (context.payload.repository && context.payload.repository.default_branch) || 'master',
  });

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pr.number, per_page: 100,
  });
  const previous = comments.find((c) => c.user && c.user.type === 'Bot' && (c.body || '').includes(MARKER));
  if (previous) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body });
    core.info(`Updated review comment ${previous.id} (verdict: ${result.verdict}).`);
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
    core.info(`Posted review comment (verdict: ${result.verdict}).`);
  }
}

module.exports = {
  run,
  analyze,
  buildComment,
  parsePatch,
  entryName,
  normalizeUrl,
  isPlatformHost,
  categoryOf,
  monthsBetween,
  MARKER,
  MAINTAINER,
};
