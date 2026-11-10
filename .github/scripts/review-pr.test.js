'use strict';

// Run with: node --test .github/scripts/review-pr.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, buildComment, run, MARKER, MAX_ENTRIES } = require('./review-pr.js');

const BASE = `# Awesome list

> intro

## Tech

### Data
- Supabase - https://supabase.com
- Firebase - https://firebase.google.com

### Static Site Hosting
- Netlify - https://www.netlify.com
- Amazon S3 - https://aws.amazon.com/s3/

## Business

### Analytics
- Plausible - https://plausible.io
`;

const NOW = new Date('2026-10-31T00:00:00Z');
const oldDomain = async (host) => ({ ok: true, domain: host, registered: '2015-01-01T00:00:00Z' });
const youngDomain = async (host) => ({ ok: true, domain: host, registered: '2026-06-15T00:00:00Z' });
const rdapFail = async () => ({ ok: false, error: 'domain not found in RDAP' });
const siteOk = async (url) => ({ ok: true, status: 200, finalUrl: url });

// Build a files[] + head README for a PR that inserts `lines` after `after`
// and optionally removes `remove` lines.
function pr(lines, { after = '- Plausible - https://plausible.io', remove = [], extraFiles = [] } = {}) {
  let head = BASE;
  for (const r of remove) head = head.replace(r + '\n', '');
  head = head.replace(after + '\n', after + '\n' + lines.map((l) => l + '\n').join(''));
  const patch = ['@@ -1,1 +1,1 @@', ...remove.map((r) => '-' + r), ...lines.map((l) => '+' + l)].join('\n');
  const files = [{ filename: 'README.md', status: 'modified', patch }, ...extraFiles];
  return { files, baseReadme: BASE, headReadme: head, now: NOW, rdap: oldDomain, site: siteOk };
}

// Status of a check: pull-request-level checks first, then the given entry's.
const status = (result, name, entry = 0) =>
  (result.checks.find((c) => c.name === name) || result.entries[entry]?.checks.find((c) => c.name === name))?.status;

test('valid single addition passes the initial review', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is']));
  assert.equal(r.verdict, 'passed');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'Umami');
  assert.equal(r.entries[0].category, 'Analytics');
  assert.ok([...r.checks, ...r.entries[0].checks].every((c) => c.status === 'pass'), JSON.stringify(r, null, 2));
});

test('multiple valid tools in one PR pass, each checked on its own', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is', '- Fathom - https://usefathom.com']));
  assert.equal(r.verdict, 'passed');
  assert.equal(status(r, 'Additions only'), 'pass');
  assert.deepEqual(r.entries.map((e) => [e.name, e.status]), [['Umami', 'pass'], ['Fathom', 'pass']]);
});

test('one failing tool among several is rejected on its own; the rest await review', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is', '- MyApp - https://myapp.vercel.app', '- Fathom - https://usefathom.com']));
  assert.equal(r.verdict, 'partial');
  assert.deepEqual(r.entries.map((e) => e.status), ['pass', 'fail', 'pass']);
  assert.equal(status(r, 'Domain', 1), 'fail');
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /\*\*❌ Partially rejected\.\*\* 1 tool of 3 does not meet/);
  assert.match(body, /is rejected \(marked ❌ below\)\. The other 2 tools are pending final review/);
  assert.match(body, /tools marked ❌ above do not meet .* and are rejected/);
  assert.match(body, /### ❌ Rejected: 2\. `MyApp`/);
  assert.match(body, /### ✅ Passed automated checks: 1\. `Umami`/);
  assert.doesNotMatch(body, /approved|Accept/);
});

test('the same tool added twice in one PR is flagged', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is', '- Umami - https://umami.is/']));
  assert.equal(status(r, 'Not a duplicate', 0), 'pass');
  assert.equal(status(r, 'Not a duplicate', 1), 'fail');
  assert.equal(r.verdict, 'partial');
});

test(`only the first ${MAX_ENTRIES} tools are checked automatically`, async () => {
  const lines = Array.from({ length: MAX_ENTRIES + 2 }, (_, i) => `- Tool${i} - https://tool${i}.com`);
  const r = await analyze(pr(lines));
  assert.equal(r.entries.length, MAX_ENTRIES);
  assert.equal(r.unchecked.length, 2);
  assert.equal(r.verdict, 'manual');
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /Not checked automatically:\*\*/);
  assert.match(body, /`- Tool21 - https:\/\/tool21\.com`/);
});

test('changes to files other than README.md are flagged', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is'], { extraFiles: [{ filename: 'CONTRIBUTING.md', status: 'modified', patch: '+x' }] }));
  assert.equal(r.verdict, 'rejected');
  assert.equal(status(r, 'Files changed'), 'fail');
});

test('entries with a description or wrong separator fail the format check', async () => {
  for (const line of [
    '- Umami - https://umami.is - privacy-friendly analytics',
    '- Umami https://umami.is',
    '- [Umami](https://umami.is)',
    '- Umami\thttps://umami.is',
    '- Umami (privacy-friendly analytics) - https://umami.is',
    '- Umami: privacy analytics - https://umami.is',
  ]) {
    const r = await analyze(pr([line]));
    assert.equal(status(r, 'Format'), 'fail', line);
    assert.equal(r.verdict, 'rejected', line);
  }
});

test('platform subdomains are flagged', async () => {
  for (const url of ['https://myapp.vercel.app', 'https://cool.netlify.app/', 'https://me.github.io/tool']) {
    const r = await analyze(pr([`- MyApp - ${url}`]));
    assert.equal(status(r, 'Domain'), 'fail', url);
    assert.equal(r.entries[0].domainFailed, true);
    assert.equal(r.verdict, 'rejected');
  }
});

test('GitHub repository links are flagged', async () => {
  const r = await analyze(pr(['- MyTool - https://github.com/someone/mytool']));
  assert.equal(status(r, 'Domain'), 'fail');
  assert.equal(r.verdict, 'rejected');
});

test('tracking and referral parameters are flagged', async () => {
  for (const url of ['https://umami.is/?utm_source=github', 'https://umami.is/?ref=awesome', 'https://umami.is/?via=me']) {
    const r = await analyze(pr([`- Umami - ${url}`]));
    assert.equal(status(r, 'No tracking/referral'), 'fail', url);
  }
});

test('duplicate name or URL is flagged', async () => {
  const byName = await analyze(pr(['- supabase - https://supabase.io']));
  assert.equal(status(byName, 'Not a duplicate'), 'fail');
  const byUrl = await analyze(pr(['- Plausible Analytics - https://plausible.io/']));
  assert.equal(status(byUrl, 'Not a duplicate'), 'fail');
});

test('same host with a different path is only a warning', async () => {
  const r = await analyze(pr(['- Amazon Lambda - https://aws.amazon.com/lambda/']));
  assert.equal(status(r, 'Not a duplicate'), 'warn');
  assert.equal(r.verdict, 'passed');
});

test('adding a new category heading is flagged', async () => {
  const r = await analyze(pr(['### Brand New', '- Umami - https://umami.is']));
  assert.equal(status(r, 'Category'), 'fail');
  assert.equal(r.verdict, 'rejected');
});

test('entry outside any category is flagged', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is'], { after: '> intro' }));
  assert.equal(status(r, 'Category'), 'fail');
});

test('removal-only PR needs manual review', async () => {
  const r = await analyze(pr([], { remove: ['- Firebase - https://firebase.google.com'] }));
  assert.equal(r.verdict, 'manual');
  assert.equal(r.entries.length, 0);
});

test('URL update of an existing entry needs manual review', async () => {
  const r = await analyze(pr(['- Supabase - https://supabase.com/new'], {
    after: '- Firebase - https://firebase.google.com',
    remove: ['- Supabase - https://supabase.com'],
  }));
  assert.equal(r.verdict, 'manual');
});

test('new tool mixed with removals is flagged', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is'], { remove: ['- Firebase - https://firebase.google.com'] }));
  assert.equal(r.verdict, 'rejected');
  assert.equal(status(r, 'Additions only'), 'fail');
});

test('recently registered domain fails the domain age check', async () => {
  const r = await analyze({ ...pr(['- NewAI - https://newai.example']), rdap: youngDomain });
  assert.equal(status(r, 'Domain age'), 'fail');
  assert.equal(r.verdict, 'rejected');
});

test('RDAP failure is only a warning', async () => {
  const r = await analyze({ ...pr(['- Umami - https://umami.is']), rdap: rdapFail });
  assert.equal(status(r, 'Domain age'), 'warn');
  assert.equal(r.verdict, 'passed');
});

test('unreachable site is only a warning', async () => {
  const r = await analyze({ ...pr(['- Umami - https://umami.is']), site: async () => ({ ok: false, error: 'timed out' }) });
  assert.equal(status(r, 'Site reachable'), 'warn');
  assert.equal(r.verdict, 'passed');
});

test('rejection comment says so and tells the author about featured listings', async () => {
  const r = await analyze(pr(['- MyApp - https://myapp.vercel.app']));
  assert.equal(r.verdict, 'rejected');
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\*\*❌ Rejected\.\*\*/);
  assert.match(body, /so it is rejected/);
  assert.match(body, /### ❌ Rejected: `MyApp`/);
  assert.doesNotMatch(body, /pending final review/i);
  assert.match(body, /Hi @someone/);
  assert.match(body, /support@ibexoft\.com/);
  assert.match(body, /SPONSORS\.md/);
  assert.match(body, /own custom domain/);
  assert.match(body, /cannot be purchased/);
});

test('a failing PR-level check rejects the whole pull request', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is'], { extraFiles: [{ filename: 'package.json', status: 'added', patch: '+{}' }] }));
  assert.equal(r.verdict, 'rejected');
  assert.equal(r.entries[0].status, 'pass');
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /\*\*❌ Rejected\.\*\*/);
  assert.match(body, /push the fix and this review will update/);
  assert.match(body, /optional and has no effect on the review/);
  assert.match(body, /support@ibexoft\.com/);
});

test('a pull request with no new tools needs manual review, not rejection', async () => {
  const r = await analyze({ files: [{ filename: 'CONTRIBUTING.md', status: 'modified', patch: '+x' }], baseReadme: BASE, headReadme: null, now: NOW, rdap: oldDomain, site: siteOk });
  assert.equal(r.verdict, 'manual');
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /Needs manual review/);
  assert.doesNotMatch(body, /Rejected|@someone/);
});

test('passing comment is pending review, not an approval, and links the guidelines', async () => {
  const r = await analyze(pr(['- Umami - https://umami.is']));
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /\*\*✅ Passed automated checks, pending final review\*\*/);
  assert.match(body, /not an approval/);
  assert.match(body, /\(https:\/\/github\.com\/o\/r\/blob\/master\/CONTRIBUTING\.md#review-process\)/);
  assert.doesNotMatch(body, /Recommendation|Accept|approved/);
  assert.match(body, /Hi @someone, thanks for your submission\. Your submission is pending final review/);
  assert.match(body, /highlighted at the top of the list/);
  assert.match(body, /optional and has no effect on the review of this pull request/);
  assert.match(body, /support@ibexoft\.com/);
  assert.match(body, /Payment does not influence pull request reviews/);
  assert.doesNotMatch(body, /would still like|Unfortunately|custom domain\./);
});

test('user-provided text is rendered inside code spans', async () => {
  const r = await analyze(pr(['- @everyone `x` | y - https://umami.is']));
  const body = buildComment(r, { author: 'someone', repoUrl: 'https://github.com/o/r', branch: 'master' });
  assert.match(body, /`@everyone 'x' \\\| y`/);
});

function fakeGithub(login, existingComments = []) {
  const calls = { created: [], updated: [] };
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      pulls: { listFiles: async () => [{ filename: 'CONTRIBUTING.md', status: 'modified', patch: '+x' }] },
      repos: { getContent: async () => { throw new Error('not used'); } },
      issues: {
        listComments: async () => existingComments,
        createComment: async (a) => { calls.created.push(a); },
        updateComment: async (a) => { calls.updated.push(a); },
      },
    },
  };
  const context = {
    repo: { owner: 'Ibexoft', repo: 'awesome-startup-tools-list' },
    serverUrl: 'https://github.com',
    payload: {
      repository: { default_branch: 'master' },
      pull_request: { number: 1, user: { login }, head: { sha: 'abc', repo: null } },
    },
  };
  const core = { info: () => {} };
  return { github, context, core, calls };
}

test('run() never reviews pull requests opened by the maintainer', async () => {
  const f = fakeGithub('mjawaids');
  await run(f);
  assert.equal(f.calls.created.length + f.calls.updated.length, 0);
});

test('run() posts once, then updates its own comment in place', async () => {
  const f = fakeGithub('contributor');
  await run(f);
  assert.equal(f.calls.created.length, 1);
  const g = fakeGithub('contributor', [{ id: 42, user: { type: 'Bot' }, body: MARKER + '\nold' }]);
  await run(g);
  assert.equal(g.calls.created.length, 0);
  assert.equal(g.calls.updated[0].comment_id, 42);
});
