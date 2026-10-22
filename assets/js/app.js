// ScionHub SPA: client-side routing with lit-html. GitHub Pages serves 404.html (a copy of index.html)
// for unknown paths, so deep links like /filecoin-project/curio boot this app and route here.
import { html, render, nothing } from 'https://cdn.jsdelivr.net/npm/lit-html@3/lit-html.js';

const API = (window.SCIONHUB_API_BASE || 'https://openscion-filecoin-poc.jolly-bush-400d.workers.dev').replace(/\/$/, '');
const FALLBACK = { orgs: ['filecoin-project'], repos: { 'filecoin-project': ['curio', 'lotus'] } };
const DATASET = '46121';

async function getJSON(path) {
  const r = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// Returns { data, live, error }
async function tryGet(path, fallback) {
  try { return { data: await getJSON(path), live: true }; }
  catch (e) { return { data: fallback, live: false, error: String(e.message || e) }; }
}
const srcTag = (s) => html`<span class="src-tag" title=${s.live ? 'Fetched live from the ScionHub API' : `Live fetch failed (${s.error}); likely CORS. Showing fallback.`}>${s.live ? 'live' : 'fallback'}</span>`;

const pre = (lines) => html`<pre><code>${lines.join('\n')}</code></pre>`;
const ENV = `export OPENSCION_SERVER=${API}`;

/* ---------- views ---------- */
const Home = () => html`
  <section class="hero"><div class="container hero-inner">
    <div class="hero-copy">
      <h1>Agent‑scale monorepo.<br />Verifiable storage.<br />Zero infra to run.</h1>
      <p class="lede">ScionHub hosts <strong>OpenScion</strong> with repository content stored on
        <strong>Filecoin</strong> via <strong>PDP</strong> (Proof of Data Possession). Every stored piece is
        addressed by its <strong>PieceCID</strong> and read back <strong>directly from the storage provider</strong>.
        GitHub‑like orgs and repos — first org: <a href="/filecoin-project"><em>filecoin-project</em></a>.</p>
      <p class="disclaimer">This is a <strong>proof of concept</strong>. Keep expectations realistic; we keep claims honest.</p>
      <div class="hero-cta">
        <a class="btn btn-primary btn-lg" href="/getting-started#import">Import your repo</a>
        <a class="btn btn-ghost btn-lg" href="/filecoin-project">Browse filecoin-project</a>
        <a class="btn btn-ghost btn-lg" href="/getting-started">Getting started</a>
      </div>
    </div>
    <figure class="hero-art"><div class="art-card">
      <div class="art-row"><span class="chip">OpenScion</span><span class="chip">opnscn CLI</span><span class="chip">Orgs &amp; PRs</span></div>
      <div class="art-row"><span class="chip chip-accent">Filecoin PDP</span><span class="chip">PieceCID</span><span class="chip">Direct SP reads</span></div>
      <div class="art-row"><span class="chip">Multi‑tenant</span><span class="chip">Agent‑scale</span><span class="chip">Monorepo</span></div>
    </div></figure>
  </div></section>

  <section id="benefits" class="section"><div class="container">
    <h2>Why ScionHub</h2>
    <div class="grid features">
      <article class="card"><h3>Agent‑scale monorepo</h3><p>Built for <strong>AI agents collaborating in one repo</strong>: branches per user, pull requests, compare‑and‑swap refs.</p></article>
      <article class="card"><h3>Verifiable Filecoin storage</h3><p>Repo content is committed to <strong>Filecoin</strong> with <strong>PDP</strong>; storage providers prove they still hold each piece. Content is identified by <strong>PieceCID</strong>.</p></article>
      <article class="card"><h3>Read straight from the SP</h3><p>Clones fetch pieces <strong>directly from the storage provider</strong> by PieceCID (live dataset ${DATASET}).</p></article>
      <article class="card"><h3>Bring your code</h3><p>One command imports an existing directory: <code>opnscn import</code>. <a href="/getting-started#import">How to import →</a></p></article>
    </div>
  </div></section>

  <section id="architecture" class="section alt"><div class="container">
    <h2>How it works</h2>
    <div class="grid arch">
      <div class="arch-col"><ul class="checklist">
        <li>OpenScion fork at <a href="https://github.com/scionhub/openscion" target="_blank" rel="noopener">scionhub/openscion</a></li>
        <li>Import or commit with the <code>opnscn</code> CLI</li>
        <li>Content stored on Filecoin via PDP</li>
        <li>Every stored piece addressed by PieceCID</li>
        <li>Reads go directly to the storage provider</li>
      </ul></div>
      <div class="arch-col"><div class="diagram" role="img" aria-label="Agents use opnscn and the OpenScion API; content is stored on Filecoin PDP addressed by PieceCID">
        <div class="diagram-row"><span class="badge">AI agents / you</span><span class="arrow" aria-hidden="true">→</span><span class="badge">opnscn CLI</span></div>
        <div class="diagram-row"><span class="arrow" aria-hidden="true">⇣</span></div>
        <div class="diagram-row"><span class="badge">OpenScion API</span><span class="arrow" aria-hidden="true">⇄</span><span class="badge">refs &amp; PRs</span></div>
        <div class="diagram-row"><span class="arrow" aria-hidden="true">⇣</span></div>
        <div class="diagram-row"><span class="badge accent">Filecoin PDP</span><span class="arrow" aria-hidden="true">⇄</span><span class="badge">PieceCID</span></div>
      </div></div>
    </div>
    <p class="note">POC note: some recent branch commits are not yet bundled to the storage provider; see the OpenScion PoC limits.</p>
  </div></section>

  <section id="pricing" class="section"><div class="container">
    <h2>Pricing</h2>
    <div class="pricing">
      <div class="price-card"><h3>Starter</h3><p class="price">$0</p><ul><li>First <strong>6 months</strong> or first <strong>1 GB</strong> — whichever comes first</li><li>Includes org + repos</li><li>Community support</li></ul></div>
      <div class="price-card highlight"><h3>Standard</h3><p class="price"><span class="price-number">$5</span><span class="price-unit">/ GB / month</span></p>
        <ul><li>Usage‑based, billed monthly</li><li>Payable in <strong>USD</strong> or <strong>ETH</strong></li><li>Cancel anytime</li></ul>
        <a class="btn btn-primary btn-lg" href="/checkout.html" data-external>Get started</a></div>
    </div>
    <p class="disclaimer center">Proof of concept: <strong>no real payment is taken</strong>. For pilots or production, contact <a href="https://filoz.org" target="_blank" rel="noopener">FilOz</a>.</p>
  </div></section>`;

const GettingStarted = () => html`
  <div class="download-hero"><div class="container"><h1>Getting started</h1>
    <p class="tiny-note">Every command below is checked against <code>opnscn --help</code> from <a href="https://github.com/scionhub/openscion" target="_blank" rel="noopener">scionhub/openscion</a>. <a href="/cli.html" data-external>Download the CLI</a>.</p></div></div>
  <div class="page"><div class="container docs-content">
    <h2 id="setup">1. Point the CLI at ScionHub</h2>
    <p>Every command also accepts <code>--server &lt;URL&gt;</code>.</p>
    ${pre([ENV, 'opnscn server-info'])}
    <h2 id="account">2. Create an account (needed for writes)</h2>
    ${pre(['opnscn signup --username <you> --email <you@example.com>', '# later, on another machine:', 'opnscn login --user <you>'])}
    <h2 id="import">3. Import / push your repo to ScionHub</h2>
    <p><code>opnscn import</code> records a directory as the repository's first changeset, creates the ref, and turns the directory into a working copy. Content is stored on Filecoin and addressed by PieceCID.</p>
    ${pre(['cd path/to/your-project', 'opnscn import . --repo <org>/<repo> --ref main -m "initial import" --author <you>'])}
    <p class="gap-note">The CLI has no <em>create repository</em> command yet: the repo must already exist in the org (an org admin creates it). Ask on the <a href="https://github.com/scionhub/openscion" target="_blank" rel="noopener">OpenScion repo</a> to get one for your project.</p>
    <p>After the import, keep pushing changes from the same directory:</p>
    ${pre(['opnscn commit -m "describe the change"'])}
    <h2 id="clone">4. Clone an existing repo</h2>
    ${pre(['opnscn clone --repo filecoin-project/curio curio', '# only one directory:', 'opnscn clone --repo filecoin-project/curio --path <dir> curio-part'])}
    <h2 id="branch">5. Branch, commit, open a PR</h2>
    ${pre(['cd curio', '# edit files, then publish to refs/heads/users/<you>/my-feature', 'opnscn branch push my-feature -m "my change"', 'opnscn pr create --title "My change" --head refs/heads/users/<you>/my-feature --base main', 'opnscn pr list', 'opnscn pr show <number>', 'opnscn pr merge <number>   # org member or admin; fast-forward'])}
    <h2 id="sync">6. Staying in sync</h2>
    <p class="gap-note">There is no <code>pull</code>/<code>sync</code> command yet. To pick up the latest <code>main</code>, clone it fresh into an empty directory; merges into <code>main</code> go through <code>opnscn pr merge</code> (fast-forward only).</p>
    ${pre(['opnscn clone --repo filecoin-project/curio --ref main curio-latest'])}
    <h2>Browse</h2><p>See <a href="/filecoin-project">filecoin-project repositories</a>.</p>
  </div></div>`;

const OrgView = (org) => {
  const st = { s: null };
  const view = (s) => html`
    <div class="page-head"><div class="container"><div class="subnav"><a class="btn" href="/orgs/new.html" data-external>New organization</a></div></div></div>
    <div class="page"><div class="container layout-2col">
      <aside class="sidebar"><div class="card">
        <div style="display:flex;align-items:center;gap:.75rem;"><div class="org-avatar" aria-hidden="true">${org.slice(0, 2).toUpperCase()}</div>
          <div><h2 style="margin:0">${org}</h2><div class="tiny-note">@${org}</div></div></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:.9rem 0;" />
        <p class="tiny-note">Repo content stored on Filecoin (PDP dataset ${DATASET}). POC.</p>
      </div></aside>
      <section class="content">
        <h3 style="margin-bottom:.5rem;">Repositories ${s ? srcTag(s) : nothing}</h3>
        <ul class="repo-list">${!s ? html`<li class="repo-item"><span class="muted">Loading…</span></li>`
          : s.data.length ? s.data.map((r) => html`<li class="repo-item"><a href="/${org}/${r}"><strong>${org}/${r}</strong></a><span class="badge">public</span></li>`)
          : html`<li class="repo-item"><span class="muted">No repositories yet.</span></li>`}</ul>
        <p class="tiny-note">Have code to bring? <a href="/getting-started#import">Import it with <code>opnscn import</code></a>.</p>
      </section>
    </div></div>`;
  return { view: () => view(st.s), load: async (rerender) => {
    st.s = await tryGet(`/v1/orgs/${encodeURIComponent(org)}/repos`, FALLBACK.repos[org] || []);
    if (st.s.live && !Array.isArray(st.s.data)) st.s.data = st.s.data.repos || [];
    st.s.data = st.s.data.map((r) => (typeof r === 'string' ? r : r.name));
    rerender();
  } };
};

const RepoView = (org, repo) => {
  const full = `${org}/${repo}`;
  const st = { info: null, ref: null, pulls: null, tab: 'clone' };
  const tabs = {
    clone: ['Clone', [ENV, `opnscn clone --repo ${full} ${repo}`, `cd ${repo}`]],
    branch: ['Branch', ['# from inside the working copy, after editing', 'opnscn branch push my-feature -m "my change"', '# published as refs/heads/users/<you>/my-feature']],
    commit: ['Commit / push', ['opnscn commit -m "describe the change"', '# moves the current ref (members can push main;', '# non-members push refs/heads/users/<you>/*)']],
    pr: ['PR / merge', [`opnscn pr create --repo ${full} --title "My change" --head refs/heads/users/<you>/my-feature --base main`, `opnscn pr list --repo ${full}`, `opnscn pr merge --repo ${full} <number>`]],
    sync: ['Sync', ['# no pull/sync command yet; closest: fresh clone of main', `opnscn clone --repo ${full} --ref main ${repo}-latest`]],
  };
  const view = () => {
    const { info, ref, pulls } = st;
    const pullList = pulls && (Array.isArray(pulls.data) ? pulls.data : pulls.data.pulls || []);
    return html`
    <div class="page-head"><div class="container repo-head">
      <div class="tiny-note"><a href="/${org}">${org}</a> /</div>
      <h1>${repo} <span class="badge">${info?.data?.visibility || 'public'}</span> ${info ? srcTag(info) : nothing}</h1>
      ${info?.live && info.data.created_at ? html`<div class="tiny-note">Created ${new Date(info.data.created_at).toLocaleDateString()}</div>` : nothing}
    </div></div>
    <div class="page"><div class="container layout-2col">
      <section class="content">
        <div class="card">
          <h3 style="margin-top:0">Branches / refs ${ref ? srcTag(ref) : nothing}</h3>
          ${!ref ? html`<p class="muted">Loading…</p>` : ref.live
            ? html`<div class="kv"><span><strong>${ref.data.name}</strong> (default)</span><span class="mono" title="Snapshot target">${ref.data.target}</span><span class="muted">version</span><span>${ref.data.version}</span></div>`
            : html`<p><strong>main</strong> <span class="muted">(details unavailable)</span></p>`}
          <p class="tiny-note">The API exposes refs by name; a list of user branches (<code>refs/heads/users/*</code>) is not available yet.</p>
        </div>
        <div class="card" style="margin-top:1rem">
          <h3 style="margin-top:0">Pull requests ${pulls ? srcTag(pulls) : nothing}</h3>
          ${!pulls ? html`<p class="muted">Loading…</p>` : !pulls.live ? html`<p class="muted">Couldn't load pull requests from the browser. Run <code>opnscn pr list --repo ${full}</code>.</p>`
            : pullList.length ? html`<ul class="repo-list">${pullList.map((p) => html`<li class="repo-item"><span>#${p.number} ${p.title}</span><span class="badge">${p.state || ''}</span><span class="tiny-note">${p.head} → ${p.base}</span></li>`)}</ul>`
            : html`<p class="muted">No open pull requests.</p>`}
        </div>
      </section>
      <aside class="sidebar"><div class="card cli-panel">
        <h3 style="margin-top:0">Quick CLI</h3>
        <div class="cli-tabs" role="tablist">${Object.entries(tabs).map(([k, [label]]) => html`<button role="tab" aria-selected=${st.tab === k} @click=${() => { st.tab = k; draw(); }}>${label}</button>`)}</div>
        ${pre(tabs[st.tab][1])}
        <p class="tiny-note">Content is fetched from Filecoin storage providers by PieceCID. <a href="/getting-started">Full guide</a> · <a href="/cli.html" data-external>Get opnscn</a></p>
      </div></aside>
    </div></div>`;
  };
  return { view, load: async (rerender) => {
    const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
    await Promise.all([
      tryGet(b, { org, name: repo, visibility: 'public' }).then((s) => { st.info = s; rerender(); }),
      tryGet(b + '/refs/main', null).then((s) => { st.ref = s; rerender(); }),
      tryGet(b + '/pulls', { pulls: [] }).then((s) => { st.pulls = s; rerender(); }),
    ]);
  } };
};

const NotFound = () => html`<div class="page"><div class="container"><h1>Not found</h1><p><a href="/">Back home</a></p></div></div>`;

/* ---------- router ---------- */
const main = document.getElementById('main');
let current = null;
function draw() { render(current.view(), main); }
function route() {
  const parts = location.pathname.replace(/\/index\.html$/, '/').split('/').filter(Boolean).map(decodeURIComponent);
  let title = 'ScionHub';
  if (parts.length === 0) current = { view: Home };
  else if (parts.length === 1 && parts[0] === 'getting-started') { current = { view: GettingStarted }; title = 'Getting started — ScionHub'; }
  else if (parts.length === 1) { current = OrgView(parts[0]); title = `${parts[0]} — ScionHub`; }
  else if (parts.length === 2) { current = RepoView(parts[0], parts[1]); title = `${parts.join('/')} — ScionHub`; }
  else current = { view: NotFound };
  document.title = title;
  document.querySelectorAll('#site-nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === location.pathname));
  draw();
  if (current.load) current.load(draw);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  else window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('data-external') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || /\.\w+$/.test(u.pathname)) return;
  e.preventDefault();
  if (u.pathname === location.pathname && u.hash) { history.pushState(null, '', u); document.getElementById(u.hash.slice(1))?.scrollIntoView(); return; }
  history.pushState(null, '', u);
  route();
});
window.addEventListener('popstate', route);
route();
