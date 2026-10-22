// ScionHub SPA: client-side routing with lit-html.
// GitHub Pages serves 404.html (a copy of index.html) for unknown paths, so
// /filecoin-project/curio still boots this app. Hash routes (/#/org/repo/...)
// work on any static host without a fallback.
import { html, render, nothing } from 'https://cdn.jsdelivr.net/npm/lit-html@3/lit-html.js';

const API = (window.SCIONHUB_API_BASE || 'https://openscion-filecoin-poc.jolly-bush-400d.workers.dev').replace(/\/$/, '');
const FALLBACK = { orgs: ['filecoin-project'], repos: { 'filecoin-project': ['curio', 'lotus'] } };
const DATASET = '46121';
const AUTH_KEY = 'scionhub.auth';
const ENV = `export OPENSCION_SERVER=${API}`;
const README_NAMES = ['README.md', 'README', 'readme.md', 'Readme.md'];
const MAX_BLOB_BYTES = 512 * 1024;
const MAX_BLOB_LINES = 4000;
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/* ---------- auth ---------- */
function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
  catch { return null; }
}
function setAuth(value) {
  if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
  else localStorage.removeItem(AUTH_KEY);
  drawNav();
}

/* ---------- http ---------- */
function errMessage(data, status) {
  if (data && typeof data === 'object') return data.error || data.message || `HTTP ${status}`;
  if (typeof data === 'string' && data.trim()) return data;
  return `HTTP ${status}`;
}
async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const a = getAuth();
    if (a?.token) headers.Authorization = `Bearer ${a.token}`;
  }
  const r = await fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error(errMessage(data, r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}
async function tryGet(path, fallback) {
  try { return { data: await api(path), live: true }; }
  catch (e) { return { data: fallback, live: false, error: String(e.message || e), status: e.status }; }
}
const srcTag = (s) => !s ? nothing : html`<span class="src-tag" title=${s.live ? 'Fetched live from the ScionHub API' : `Live fetch failed (${s.error || 'unavailable'}); showing fallback.`}>${s.live ? 'live' : 'fallback'}</span>`;

const pre = (lines) => html`<pre><code>${(Array.isArray(lines) ? lines : [lines]).join('\n')}</code></pre>`;

function encodeSegs(parts) {
  return parts.map((p) => encodeURIComponent(p)).join('/');
}
function hashUrl(parts) {
  return '/#/' + encodeSegs(parts);
}
function orgUrl(org) { return hashUrl([org]); }
function repoUrl(org, repo, extra = []) { return hashUrl([org, repo, ...extra]); }
function treeUrl(org, repo, ref, path = '') {
  const segs = [org, repo, 'tree', ref];
  if (path) segs.push(...path.split('/').filter(Boolean));
  return hashUrl(segs);
}
function blobUrl(org, repo, ref, path) {
  return hashUrl([org, repo, 'blob', ref, ...String(path).split('/').filter(Boolean)]);
}
function apiRef(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

function fmtTime(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(n)) return String(v);
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}
function shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? s.slice(0, 8) : s;
}
function fmtSize(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}
function kindOf(entry) {
  const k = (entry.kind || '').toLowerCase();
  if (k === 'dir' || k === 'tree' || k === 'directory') return 'dir';
  if (k === 'symlink' || k === 'link') return 'symlink';
  return 'file';
}
function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    const ad = kindOf(a) === 'dir' ? 0 : 1;
    const bd = kindOf(b) === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function safeHref(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (u.startsWith('/') || u.startsWith('#') || u.startsWith('mailto:')) return u;
  try {
    const parsed = new URL(u, location.href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch { /* ignore */ }
  return null;
}

function inlineMd(text) {
  const out = [];
  const re = /(`[^`]+`)|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(html`<code>${m[1].slice(1, -1)}</code>`);
    else {
      const href = safeHref(m[3]);
      if (href) out.push(html`<a href=${href} rel="noopener">${m[2]}</a>`);
      else out.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const fence = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        fence.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(html`<pre><code>${fence.join('\n')}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const inner = inlineMd(heading[2]);
      const n = heading[1].length;
      blocks.push(n === 1 ? html`<h1>${inner}</h1>`
        : n === 2 ? html`<h2>${inner}</h2>`
        : n === 3 ? html`<h3>${inner}</h3>`
        : n === 4 ? html`<h4>${inner}</h4>`
        : n === 5 ? html`<h5>${inner}</h5>`
        : html`<h6>${inner}</h6>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(html`<li>${inlineMd(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      blocks.push(html`<ul>${items}</ul>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !lines[i].startsWith('#') && !lines[i].startsWith('```')
      && !/^\s*[-*]\s+/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(html`<p>${inlineMd(para.join(' '))}</p>`);
  }
  return html`<div class="md-body">${blocks}</div>`;
}

function isLikelyText(bytes, name) {
  const n = name || '';
  if (/\.(png|jpe?g|gif|webp|ico|bmp|zip|gz|tgz|bz2|xz|woff2?|ttf|otf|eot|bin|wasm|mp4|webm|pdf|so|dylib|a)$/i.test(n)) return false;
  if (!bytes || bytes.length === 0) return true;
  if (bytes.includes(0)) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample[i];
    if (c < 7 || (c > 13 && c < 32 && c !== 9)) weird += 1;
  }
  return weird / sample.length < 0.05;
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchRange(url, offset, length) {
  const start = Number(offset);
  const len = Number(length);
  const headers = {};
  if (Number.isFinite(start) && Number.isFinite(len) && len >= 0) {
    const end = start + len - 1;
    headers.Range = `bytes=${start}-${end}`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok && r.status !== 206) throw new Error(`storage provider HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ---------- snapshot / tree / blob (live browse endpoints, with fallbacks) ---------- */
const snapCache = new Map();

async function loadSnapshot(org, repo, ref) {
  const key = `${org}/${repo}@${ref}`;
  if (snapCache.has(key)) return snapCache.get(key);
  const pending = (async () => {
    try {
      const refInfo = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/refs/${apiRef(ref)}`);
      const cs = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/changesets/${encodeURIComponent(refInfo.target)}`);
      return { refInfo, cs };
    } catch {
      const cs = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/changesets/${encodeURIComponent(ref)}`);
      return { refInfo: { name: ref, target: cs.id, version: cs.lsn }, cs };
    }
  })();
  snapCache.set(key, pending);
  try { return await pending; }
  catch (e) { snapCache.delete(key); throw e; }
}

function entriesFromChanges(cs, dirPath) {
  const changes = cs?.changes || [];
  const metadata = cs?.metadata || {};
  const prefix = dirPath ? `${dirPath.replace(/\/+$/, '')}/` : '';
  const dirs = new Map();
  const files = [];
  for (const c of changes) {
    if (!c || c.op === 'delete') continue;
    const p = c.path || '';
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({
        name: rest,
        kind: kindOf(c) === 'dir' ? 'dir' : (c.kind === 'symlink' ? 'symlink' : 'file'),
        id: c.blob || c.id,
        size: c.size ?? null,
        pieceCid: metadata[`pcid:${p}`] || null,
      });
    } else {
      const name = rest.slice(0, slash);
      if (!dirs.has(name)) {
        dirs.set(name, { name, kind: 'dir', id: null, size: null, pieceCid: null });
      }
    }
  }
  return sortEntries([...dirs.values(), ...files]);
}

async function loadTree(org, repo, ref, path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  try {
    const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${apiRef(ref)}${q}`);
    return { live: true, entries: sortEntries(data.entries || []), data };
  } catch (e) {
    const { cs, refInfo } = await loadSnapshot(org, repo, ref);
    return { live: false, fallback: true, error: e.message, entries: entriesFromChanges(cs, path), cs, refInfo };
  }
}

async function resolvePiece(org, repo, pieceCid) {
  const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/objects/resolve`, {
    method: 'POST',
    body: { ids: [pieceCid] },
  });
  const row = (data.results || []).find((r) => r && (r.pieceCid === pieceCid || r.url)) || (data.results || [])[0];
  if (!row) throw new Error('resolve returned no location');
  return row;
}

async function bytesFromHint(org, repo, hint) {
  const loc = { ...hint };
  if ((!loc.url || loc.offset == null) && loc.pieceCid) {
    Object.assign(loc, await resolvePiece(org, repo, loc.pieceCid));
  }
  if (loc.contentBase64) {
    return { bytes: b64ToBytes(loc.contentBase64), loc };
  }
  if (loc.url) {
    try {
      const bytes = await fetchRange(loc.url, loc.offset, loc.length ?? loc.size);
      return { bytes, loc };
    } catch (e) {
      return { bytes: null, loc, spError: e.message };
    }
  }
  return { bytes: null, loc, spError: 'no storage URL' };
}

async function loadBlob(org, repo, ref, path) {
  try {
    const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/blob/${apiRef(ref)}?path=${encodeURIComponent(path)}`);
    const fetched = await bytesFromHint(org, repo, data);
    return { live: true, data, ...fetched };
  } catch (e) {
    const { cs } = await loadSnapshot(org, repo, ref);
    const pieceCid = cs?.metadata?.[`pcid:${path}`];
    const change = (cs?.changes || []).find((c) => c.path === path);
    if (!pieceCid && !change) throw e;
    const hint = { pieceCid, size: change?.size, path };
    const fetched = await bytesFromHint(org, repo, hint);
    return { live: false, fallback: true, error: e.message, data: { path, pieceCid, ...fetched.loc }, ...fetched };
  }
}

async function loadCommits(org, repo, ref) {
  try {
    const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/commits/${apiRef(ref)}?limit=20`);
    return { live: true, commits: data.commits || data || [] };
  } catch (e) {
    try {
      const { cs } = await loadSnapshot(org, repo, ref);
      return {
        live: false,
        fallback: true,
        error: e.message,
        commits: [{
          id: cs.id,
          message: cs.message,
          author: cs.author,
          created_at: cs.created_at,
          parents: cs.parents,
          root_tree: cs.root_tree,
        }],
      };
    } catch (e2) {
      return { live: false, error: e2.message, commits: [] };
    }
  }
}

function findReadme(entries) {
  const files = (entries || []).filter((e) => kindOf(e) === 'file');
  for (const name of README_NAMES) {
    const hit = files.find((e) => e.name === name);
    if (hit) return hit;
  }
  return null;
}

/* ---------- views ---------- */
const Home = () => html`
  <section class="hero"><div class="container hero-inner">
    <div class="hero-copy">
      <h1>Agent‑scale monorepo.<br />Verifiable storage.<br />Zero infra to run.</h1>
      <p class="lede">ScionHub hosts <strong>OpenScion</strong> with repository content stored on
        <strong>Filecoin</strong> via <strong>PDP</strong> (Proof of Data Possession). Every stored piece is
        addressed by its <strong>PieceCID</strong> and read back <strong>directly from the storage provider</strong>.
        GitHub‑like orgs and repos — first org: <a href=${orgUrl('filecoin-project')}><em>filecoin-project</em></a>.</p>
      <p class="disclaimer">This is a <strong>proof of concept</strong>. Keep expectations realistic; we keep claims honest.</p>
      <div class="hero-cta">
        <a class="btn btn-primary btn-lg" href="/#/getting-started#import">Import your repo</a>
        <a class="btn btn-ghost btn-lg" href=${orgUrl('filecoin-project')}>Browse filecoin-project</a>
        <a class="btn btn-ghost btn-lg" href="/#/getting-started">Getting started</a>
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
      <article class="card"><h3>Bring your code</h3><p>One command imports an existing directory: <code>opnscn import</code>. <a href="/#/getting-started">How to import →</a></p></article>
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
    <p class="note">Commits and merged PRs upload only new or changed content to the storage provider; unchanged files keep their existing PieceCIDs, so every branch and merged <code>main</code> clones straight from Filecoin.</p>
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
    <p class="tiny-note">Commands match <code>opnscn --help</code> from <a href="https://github.com/scionhub/openscion" target="_blank" rel="noopener">scionhub/openscion</a> and <a href="${API}/docs" data-external>live /docs</a>. <a href="/cli.html" data-external>Download the CLI</a>.</p></div></div>
  <div class="page"><div class="container docs-content">
    <h2 id="setup">1. Point the CLI at ScionHub</h2>
    <p>Every command also accepts <code>--server &lt;URL&gt;</code>.</p>
    ${pre([ENV, 'opnscn server-info'])}

    <h2 id="account">2. Create an account and log in</h2>
    <p>Needed for writes. Username must match <code>^[a-z0-9][a-z0-9-]{2,31}$</code>; password at least 10 characters. Or use the <a href="/#/login">web signup / login</a>.</p>
    ${pre(['opnscn signup --username <you>', 'opnscn signup --username <you> --email <you@example.com>', 'opnscn login --user <you>'])}

    <h2 id="create">3. Create a repository</h2>
    <p>Logged-in users can create a public repo under their username org (created on first use) or an org they belong to. <code>filecoin-project</code> stays admin-only. Non-admins are limited to 3 repos. The name must match <code>^[a-z0-9][a-z0-9._-]{0,63}$</code>.</p>
    <p>On the web: <a href="/#/new">New repository</a> (sign in first). With the CLI:</p>
    ${pre(['opnscn repo create <name>', 'opnscn repo create <name> --org <org>'])}
    <p>Then import or push the first commit:</p>
    ${pre(['opnscn import ./src --repo <org>/<repo>', '# or, from a working copy of that repo:', 'opnscn commit -m "first" --ref main'])}

    <h2 id="import">4. Import / push a directory</h2>
    <p><code>opnscn import</code> records a directory as the repository’s first changeset, creates the ref, and turns the directory into a working copy. Content is stored on Filecoin and addressed by PieceCID.</p>
    ${pre(['cd path/to/your-project', 'opnscn import . --repo <org>/<repo> --ref main -m "initial import" --author <you>'])}
    <p>After the import, keep pushing changes from the same directory:</p>
    ${pre(['opnscn commit -m "describe the change"'])}

    <h2 id="clone">5. Clone an existing repo</h2>
    <p>Public clones need no account.</p>
    ${pre(['opnscn clone ./curio --repo filecoin-project/curio', 'opnscn clone ./curio --repo filecoin-project/curio --ref main', 'opnscn clone ./curio --repo filecoin-project/curio --path src'])}

    <h2 id="branch">6. Branch, commit, open a PR</h2>
    <p>Org members can move any ref. Anyone logged in can push under <code>refs/heads/users/&lt;you&gt;/*</code> on a public repo.</p>
    ${pre(['cd curio', '# edit files, then publish to refs/heads/users/<you>/my-feature', 'opnscn branch push my-feature -m "my change"', 'opnscn pr create --title "My change" --head refs/heads/users/<you>/my-feature --base main', 'opnscn pr list', 'opnscn pr show <number>', 'opnscn pr merge <number>   # org member or admin; fast-forward'])}

    <h2 id="sync">7. Sync a branch and resolve conflicts</h2>
    <p><code>opnscn sync</code> three-way-merges the working copy with a target ref (default <code>main</code>), including uncommitted local edits. Upstream-only changes are taken; local-only changes are kept; both-changed paths get git-style markers. The next <code>opnscn commit</code> / <code>opnscn branch push</code> records a changeset whose first parent is that target so <code>opnscn pr merge</code> can fast-forward. Commit refuses while <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</code> markers remain.</p>
    ${pre(['opnscn clone ./work --repo alice/my-repo', 'cd work', 'opnscn branch push feature', '# ... meanwhile main moved; edit files, then:', 'opnscn sync', 'opnscn sync --from main --dir .'])}
    <p>A conflicted file looks like:</p>
    <pre class="conflict-sample"><code><span class="mark">&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</span>
the line as it is on your branch
=======
the line as it is on main
<span class="mark">&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</span></code></pre>
    <p>Edit the file to the resolved contents (remove the markers), then:</p>
    ${pre(['opnscn commit -m "merge main"', 'opnscn branch push feature', 'opnscn pr create --title "Feature" --head refs/heads/users/alice/feature', 'opnscn pr merge 1'])}

    <h2>Browse</h2>
    <p>See <a href=${orgUrl('filecoin-project')}>filecoin-project repositories</a>.</p>
  </div></div>`;

const LoginView = () => {
  const st = { loginErr: '', signupErr: '', loginBusy: false, signupBusy: false };
  const view = () => html`
    <div class="page"><div class="container">
      <h1>Sign in</h1>
      <p class="tiny-note">Accounts are stored on the OpenScion API. Username <code>^[a-z0-9][a-z0-9-]{2,31}$</code>, password at least 10 characters.</p>
      <div class="auth-grid">
        <form class="card form" @submit=${onLogin}>
          <h2 style="margin-top:0">Log in</h2>
          <label for="login-user">Username</label>
          <input id="login-user" name="name" type="text" autocomplete="username" required pattern="[a-z0-9][a-z0-9-]{2,31}" />
          <label for="login-pass">Password</label>
          <input id="login-pass" name="password" type="password" autocomplete="current-password" required minlength="10" />
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.loginBusy}>${st.loginBusy ? 'Signing in…' : 'Log in'}</button></div>
          ${st.loginErr ? html`<p class="form-error">${st.loginErr}</p>` : nothing}
        </form>
        <form class="card form" @submit=${onSignup}>
          <h2 style="margin-top:0">Create account</h2>
          <label for="su-user">Username</label>
          <input id="su-user" name="username" type="text" autocomplete="username" required pattern="[a-z0-9][a-z0-9-]{2,31}" />
          <label for="su-email">Email (optional)</label>
          <input id="su-email" name="email" type="email" autocomplete="email" />
          <label for="su-pass">Password</label>
          <input id="su-pass" name="password" type="password" autocomplete="new-password" required minlength="10" />
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.signupBusy}>${st.signupBusy ? 'Creating…' : 'Sign up'}</button></div>
          ${st.signupErr ? html`<p class="form-error">${st.signupErr}</p>` : nothing}
        </form>
      </div>
    </div></div>`;
  async function onLogin(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    st.loginErr = ''; st.loginBusy = true; draw();
    try {
      const name = String(fd.get('name') || '').trim();
      const password = String(fd.get('password') || '');
      const data = await api('/v1/auth/login', { method: 'POST', body: { name, password } });
      if (!data?.token) throw new Error('login did not return a token');
      setAuth({ token: data.token, username: name });
      const next = parseLocation().query.get('next');
      navigate(next && next.startsWith('/') ? next : '/#/');
    } catch (err) { st.loginErr = err.message || String(err); st.loginBusy = false; draw(); }
  }
  async function onSignup(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    st.signupErr = ''; st.signupBusy = true; draw();
    try {
      const username = String(fd.get('username') || '').trim();
      const email = String(fd.get('email') || '').trim();
      const password = String(fd.get('password') || '');
      if (!USER_RE.test(username)) throw new Error('username must match ^[a-z0-9][a-z0-9-]{2,31}$');
      if (password.length < 10) throw new Error('password must be at least 10 characters');
      const body = { username, password };
      if (email) body.email = email;
      const data = await api('/v1/auth/signup', { method: 'POST', body });
      if (!data?.token) throw new Error('signup did not return a token');
      setAuth({ token: data.token, username });
      navigate('/#/new');
    } catch (err) { st.signupErr = err.message || String(err); st.signupBusy = false; draw(); }
  }
  return { view };
};

const NewRepoView = () => {
  const auth = getAuth();
  const st = { owners: auth?.username ? [auth.username] : [], err: '', busy: false, created: null };
  const view = () => {
    if (!auth) {
      return html`<div class="page"><div class="container narrow">
        <h1>New repository</h1>
        <p>Sign in to create a repository under your username.</p>
        <p><a class="btn btn-primary" href="/#/login">Sign in</a></p>
      </div></div>`;
    }
    if (st.created) {
      const c = st.created;
      const full = `${c.org}/${c.name}`;
      const days = c.retention?.freeDays ?? 60;
      const pay = c.retention?.payUrl || '/checkout.html';
      return html`<div class="page"><div class="container narrow">
        <h1>Repository created</h1>
        <p><strong>${full}</strong> is ready. Visibility: ${c.visibility || 'public'}.</p>
        <div class="pay-prompt">
          <p style="margin:0 0 .5rem"><strong>Pay now so your repo isn't removed after ${days} days.</strong></p>
          <p class="tiny-note" style="margin:0 0 .6rem">Proof of concept — checkout is an explainer only and does not charge you.</p>
          <a class="btn btn-primary" href=${pay} data-external>Pay now (POC checkout)</a>
        </div>
        <p><a class="btn" href=${repoUrl(c.org, c.name)}>Open ${full}</a></p>
        <h2>Push the first content</h2>
        ${pre([ENV, `opnscn import ./src --repo ${full}`, `# or, from the project directory:`, `opnscn import . --repo ${full} --ref main -m "initial import"`])}
      </div></div>`;
    }
    return html`<div class="page"><div class="container narrow">
      <h1>New repository</h1>
      <p class="tiny-note">Creates a public repo via <code>POST /v1/repos</code>. Non-admins: 3 repos max. <code>filecoin-project</code> is admin-only.</p>
      <form class="card form" @submit=${onCreate}>
        <label for="repo-owner">Owner</label>
        <select id="repo-owner" name="org">${st.owners.map((o) => html`<option value=${o} ?selected=${o === auth.username}>${o}</option>`)}</select>
        <label for="repo-name">Repository name</label>
        <input id="repo-name" name="name" type="text" required pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="my-repo" />
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>${st.busy ? 'Creating…' : 'Create repository'}</button></div>
        ${st.err ? html`<p class="form-error">${st.err}</p>` : nothing}
      </form>
    </div></div>`;
  };
  async function onCreate(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    const org = String(fd.get('org') || auth.username).trim();
    st.err = ''; st.busy = true; draw();
    try {
      if (!REPO_NAME_RE.test(name)) throw new Error('invalid repo name');
      const data = await api('/v1/repos', { method: 'POST', auth: true, body: { name, org } });
      st.created = data;
      st.busy = false;
      draw();
    } catch (err) { st.err = err.message || String(err); st.busy = false; draw(); }
  }
  return {
    view,
    load: async (rerender) => {
      const owners = [];
      if (auth?.username) owners.push(auth.username);
      const tryPaths = ['/v1/me', '/v1/me/orgs', `/v1/users/${encodeURIComponent(auth?.username || '')}/orgs`];
      for (const p of tryPaths) {
        if (!auth) break;
        try {
          const data = await api(p, { auth: true });
          const list = Array.isArray(data) ? data
            : data?.orgs || data?.memberships || data?.organizations || [];
          for (const item of list) {
            const id = typeof item === 'string' ? item : item?.id || item?.org || item?.name;
            if (id && id !== 'filecoin-project' && !owners.includes(id)) owners.push(id);
          }
        } catch { /* not discoverable yet */ }
      }
      st.owners = owners.length ? owners : (auth?.username ? [auth.username] : []);
      rerender();
    },
  };
};

const OrgView = (org) => {
  const st = { s: null };
  const view = (s) => html`
    <div class="page-head"><div class="container"><div class="subnav">
      <a class="btn" href="/orgs/new.html" data-external>New organization</a>
      ${getAuth() ? html`<a class="btn btn-primary" href="/#/new">New repository</a>` : nothing}
    </div></div></div>
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
          : s.data.length ? s.data.map((r) => html`<li class="repo-item"><a href=${repoUrl(org, r)}><strong>${org}/${r}</strong></a><span class="badge">public</span></li>`)
          : html`<li class="repo-item"><span class="muted">No repositories yet.</span></li>`}</ul>
        <p class="tiny-note">Have code to bring? <a href="/#/getting-started">Import it with <code>opnscn import</code></a>.</p>
      </section>
    </div></div>`;
  return { view: () => view(st.s), load: async (rerender) => {
    st.s = await tryGet(`/v1/orgs/${encodeURIComponent(org)}/repos`, FALLBACK.repos[org] || []);
    if (st.s.live && !Array.isArray(st.s.data)) st.s.data = st.s.data.repos || [];
    st.s.data = st.s.data.map((r) => (typeof r === 'string' ? r : r.name));
    rerender();
  } };
};

function pullList(pulls) {
  if (!pulls) return [];
  const rows = Array.isArray(pulls.data) ? pulls.data : pulls.data?.pulls || [];
  return rows;
}

const RepoView = (org, repo, opts) => {
  const full = `${org}/${repo}`;
  const st = {
    info: null,
    branches: null,
    commits: null,
    tree: null,
    blob: null,
    readme: null,
    pulls: null,
    pull: null,
    copied: false,
    tab: opts.tab || 'code',
    kind: opts.kind || 'tree',
    ref: opts.ref || 'main',
    path: opts.path || '',
    pullNo: opts.pull || null,
  };
  const cloneCmd = `opnscn clone ./${repo} --repo ${full}`;

  const onBranch = (e) => {
    const next = e.target.value;
    if (st.kind === 'blob' && st.path) navigate(blobUrl(org, repo, next, st.path));
    else navigate(treeUrl(org, repo, next, st.path));
  };
  const onCopy = async () => {
    const ok = await copyText(cloneCmd);
    st.copied = ok;
    draw();
    setTimeout(() => { st.copied = false; draw(); }, 1500);
  };

  const crumbs = () => {
    const segs = st.path.split('/').filter(Boolean);
    const items = [html`<a href=${treeUrl(org, repo, st.ref, '')}>${repo}</a>`];
    segs.forEach((seg, i) => {
      const sub = segs.slice(0, i + 1).join('/');
      const last = i === segs.length - 1 && st.kind === 'blob';
      items.push(html`<span class="muted">/</span>`);
      items.push(last
        ? html`<span>${seg}</span>`
        : html`<a href=${treeUrl(org, repo, st.ref, sub)}>${seg}</a>`);
    });
    return html`<nav class="crumbs" aria-label="Files">${items}</nav>`;
  };

  const latestCommit = () => (st.commits?.commits || [])[0] || null;

  const commitBar = () => {
    const c = latestCommit();
    if (!c) {
      return st.commits
        ? html`<div class="commit-bar"><span class="muted">${st.commits.error || 'No commits on this ref yet.'}</span></div>`
        : html`<div class="commit-bar"><span class="muted">Loading commit…</span></div>`;
    }
    return html`<div class="commit-bar">
      <span class="msg">${c.message || '(no message)'}</span>
      <span class="tiny-note">${c.author || ''}</span>
      <span class="tiny-note">${fmtTime(c.created_at)}</span>
      <span class="mono" title=${c.id}>${shortId(c.id)}</span>
    </div>`;
  };

  const fileTable = () => {
    const t = st.tree;
    if (!t) return html`<p class="muted">Loading files…</p>`;
    const entries = t.entries || [];
    const parent = st.path.split('/').filter(Boolean).slice(0, -1).join('/');
    return html`
      ${commitBar()}
      <table class="file-table">
        <tbody>
          ${st.path ? html`<tr><td class="kind">dir</td><td><a href=${treeUrl(org, repo, st.ref, parent)}>..</a></td><td class="size"></td></tr>` : nothing}
          ${entries.length ? entries.map((e) => {
            const k = kindOf(e);
            const p = st.path ? `${st.path}/${e.name}` : e.name;
            const href = k === 'dir' ? treeUrl(org, repo, st.ref, p) : blobUrl(org, repo, st.ref, p);
            return html`<tr>
              <td class="kind">${k}</td>
              <td><a href=${href}>${e.name}</a></td>
              <td class="size">${k === 'dir' ? '' : fmtSize(e.size)}</td>
            </tr>`;
          }) : html`<tr><td colspan="3" class="muted">${t.error ? `Could not list this directory (${t.error}).` : 'Empty directory.'}</td></tr>`}
        </tbody>
      </table>`;
  };

  const blobView = () => {
    const b = st.blob;
    if (!b) return html`<p class="muted">Loading file…</p>`;
    const loc = b.loc || b.data || {};
    const url = loc.url;
    const range = (loc.offset != null && loc.length != null)
      ? `bytes=${loc.offset}-${Number(loc.offset) + Number(loc.length) - 1}`
      : '';
    const rawLink = url ? html`<a href=${url} data-external target="_blank" rel="noopener">raw</a>` : nothing;
    if (b.spError || !b.bytes) {
      return html`<div class="card binary-note">
        <p>Could not fetch bytes from the storage provider${b.spError ? html`: ${b.spError}` : nothing}.</p>
        ${url ? html`<p>Raw SP URL: <a href=${url} data-external target="_blank" rel="noopener">${url}</a></p>` : nothing}
        ${range ? html`<p>Range: <code>${range}</code></p>` : nothing}
        ${loc.pieceCid ? html`<p class="tiny-note">PieceCID <span class="mono">${loc.pieceCid}</span></p>` : nothing}
      </div>`;
    }
    const size = b.bytes.length;
    if (!isLikelyText(b.bytes, st.path)) {
      return html`<div class="card binary-note">
        <p>Binary file · ${fmtSize(size)}</p>
        <p>${rawLink}</p>
        ${range ? html`<p class="tiny-note">Range <code>${range}</code></p>` : nothing}
      </div>`;
    }
    let text = decodeUtf8(b.bytes);
    let truncated = false;
    if (b.bytes.length > MAX_BLOB_BYTES) {
      text = decodeUtf8(b.bytes.subarray(0, MAX_BLOB_BYTES));
      truncated = true;
    }
    let lines = text.split('\n');
    if (lines.length > MAX_BLOB_LINES) {
      lines = lines.slice(0, MAX_BLOB_LINES);
      truncated = true;
    }
    return html`
      <div class="blob-head"><span>${st.path.split('/').pop()} · ${fmtSize(size)} ${rawLink}</span>
        ${range ? html`<span class="tiny-note"><code>${range}</code></span>` : nothing}</div>
      <div class="blob-frame with-head"><table class="blob-table">${lines.map((ln, i) => html`<tr><td class="ln">${i + 1}</td><td class="src">${ln}</td></tr>`)}</table></div>
      ${truncated ? html`<p class="tiny-note">Preview truncated.</p>` : nothing}`;
  };

  const readmeView = () => {
    if (st.kind !== 'tree') return nothing;
    const r = st.readme;
    if (!r) return nothing;
    if (r.loading) return html`<div class="readme-wrap card"><h2>README</h2><p class="muted">Loading…</p></div>`;
    if (!r.bytes) return nothing;
    if (!isLikelyText(r.bytes, r.name)) return nothing;
    const text = decodeUtf8(r.bytes);
    const md = /\.md$/i.test(r.name);
    return html`<div class="readme-wrap card">
      <h2>${r.name}</h2>
      ${md ? renderMarkdown(text) : html`<pre><code>${text}</code></pre>`}
    </div>`;
  };

  const codeTab = () => html`
    <div class="file-toolbar">
      <label class="branch-select">Branch
        <select @change=${onBranch} aria-label="Branch">
          ${[st.ref, ...((st.branches?.data?.branches || []).map((b) => (typeof b === 'string' ? b : b.name)))].filter((n, i, a) => n && a.indexOf(n) === i).map((name) => html`<option value=${name} ?selected=${name === st.ref}>${name}</option>`)}
        </select>
      </label>
      <div class="clone-box">
        <code>${cloneCmd}</code>
        <button type="button" @click=${onCopy}>${st.copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
    ${crumbs()}
    ${st.kind === 'blob' ? blobView() : html`${fileTable()}${readmeView()}`}`;

  const pullsTab = () => {
    if (st.pullNo) {
      const p = st.pull;
      if (!p) return html`<p class="muted">Loading pull request…</p>`;
      if (!p.live) return html`<p class="muted">Could not load PR #${st.pullNo}: ${p.error}</p>`;
      return html`
        <p><a href=${repoUrl(org, repo, ['pulls'])}>← Pull requests</a></p>
        <h2>#${p.data.number} ${p.data.title || ''}</h2>
        <pre class="json-dump"><code>${JSON.stringify(p.data, null, 2)}</code></pre>`;
    }
    const rows = pullList(st.pulls).filter((p) => (p.state || 'open') === 'open');
    return html`
      <h2 style="margin-top:0">Open pull requests ${st.pulls ? srcTag(st.pulls) : nothing}</h2>
      ${!st.pulls ? html`<p class="muted">Loading…</p>`
        : !st.pulls.live ? html`<p class="muted">Couldn't load pull requests (${st.pulls.error}). Try <code>opnscn pr list --repo ${full}</code>.</p>`
        : rows.length ? html`<ul class="repo-list">${rows.map((p) => html`<li class="repo-item pr-item">
            <a href=${repoUrl(org, repo, ['pulls', String(p.number)])}><strong>#${p.number}</strong> ${p.title}</a>
            <span class="badge">${p.state || 'open'}</span>
            <span class="pr-meta">${p.author || p.author_name || 'unknown'} · ${p.head_ref || p.head || ''} · ${fmtTime(p.created_at)}</span>
          </li>`)}</ul>`
        : html`<p class="muted">No open pull requests.</p>`}`;
  };

  const syncTab = () => html`
    <h2 style="margin-top:0">Sync this branch</h2>
    <p><code>opnscn sync</code> three-way-merges your working copy with a target ref (default <code>main</code>), including uncommitted local edits. Upstream-only changes are taken; local-only changes are kept; both-changed paths get git-style markers. Commit refuses while conflict markers remain.</p>
    ${pre([ENV, `opnscn clone ./${repo} --repo ${full}`, `cd ${repo}`, 'opnscn branch push my-feature', '# edit files; if main moved:', 'opnscn sync', 'opnscn sync --from main --dir .'])}
    <p>A conflicted file looks like:</p>
    <pre class="conflict-sample"><code><span class="mark">&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</span>
the line as it is on your branch
=======
the line as it is on main
<span class="mark">&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</span></code></pre>
    <p>Remove the markers, keep the resolved contents, then:</p>
    ${pre(['opnscn commit -m "merge main"', 'opnscn branch push my-feature', `opnscn pr create --repo ${full} --title "My change" --head refs/heads/users/<you>/my-feature --base main`, `opnscn pr merge --repo ${full} 1`])}
    <p class="tiny-note"><a href="/#/getting-started">Full getting-started guide</a></p>`;

  const view = () => html`
    <div class="page-head"><div class="container repo-head">
      <div class="repo-title">
        <div class="tiny-note"><a href=${orgUrl(org)}>${org}</a> /</div>
        <h1><a href=${repoUrl(org, repo)}>${repo}</a> <span class="badge">${st.info?.data?.visibility || 'public'}</span> ${st.info ? srcTag(st.info) : nothing}</h1>
      </div>
      ${st.info?.live && st.info.data.created_at ? html`<div class="tiny-note">Created ${fmtTime(st.info.data.created_at)}</div>` : nothing}
    </div></div>
    <div class="page"><div class="container">
      <nav class="repo-tabs" aria-label="Repository">
        <a href=${repoUrl(org, repo)} aria-current=${st.tab === 'code' ? 'page' : nothing}>Code</a>
        <a href=${repoUrl(org, repo, ['pulls'])} aria-current=${st.tab === 'pulls' ? 'page' : nothing}>Pull requests</a>
        <a href=${repoUrl(org, repo, ['sync'])} aria-current=${st.tab === 'sync' ? 'page' : nothing}>Sync</a>
      </nav>
      ${st.tab === 'pulls' ? pullsTab() : st.tab === 'sync' ? syncTab() : codeTab()}
    </div></div>`;

  return {
    view,
    load: async (rerender) => {
      const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
      tryGet(b, { org, name: repo, visibility: 'public' }).then((s) => { st.info = s; rerender(); });
      tryGet(`${b}/branches`, { branches: [{ name: 'main', target: '' }] }).then((s) => {
        if (s.live && !s.data.branches) s.data = { branches: s.data };
        st.branches = s;
        rerender();
      });
      if (st.tab === 'pulls') {
        if (st.pullNo) {
          tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}`, null).then((s) => { st.pull = s; rerender(); });
        } else {
          tryGet(`${b}/pulls`, { pulls: [] }).then((s) => { st.pulls = s; rerender(); });
        }
        return;
      }
      if (st.tab !== 'code') return;
      loadCommits(org, repo, st.ref).then((c) => { st.commits = c; rerender(); }).catch(() => {});
      if (st.kind === 'blob' && st.path) {
        loadBlob(org, repo, st.ref, st.path).then((blob) => { st.blob = blob; rerender(); }).catch((e) => {
          st.blob = { bytes: null, loc: {}, spError: e.message };
          rerender();
        });
        return;
      }
      try {
        const tree = await loadTree(org, repo, st.ref, st.path);
        st.tree = tree;
        rerender();
        const readmeEnt = findReadme(tree.entries);
        if (readmeEnt) {
          const rpath = st.path ? `${st.path}/${readmeEnt.name}` : readmeEnt.name;
          st.readme = { loading: true, name: readmeEnt.name };
          rerender();
          try {
            const blob = await loadBlob(org, repo, st.ref, rpath);
            st.readme = { name: readmeEnt.name, bytes: blob.bytes, loc: blob.loc };
          } catch {
            st.readme = null;
          }
          rerender();
        }
      } catch (e) {
        st.tree = { entries: [], error: e.message };
        rerender();
      }
    },
  };
};

const NotFound = () => html`<div class="page"><div class="container"><h1>Not found</h1><p><a href="/">Back home</a></p></div></div>`;

/* ---------- router ---------- */
const main = document.getElementById('main');
let current = null;
let lastKey = '';

function draw() {
  if (current && main) render(current.view(), main);
}

function parseLocation() {
  let raw = '';
  let section = null;
  let query = new URLSearchParams(location.search);
  if (location.hash.startsWith('#/')) {
    raw = location.hash.slice(2);
    const qAt = raw.indexOf('?');
    const hAt = raw.indexOf('#');
    const cut = (qAt >= 0 && hAt >= 0) ? Math.min(qAt, hAt) : (qAt >= 0 ? qAt : hAt);
    const pathPart = cut >= 0 ? raw.slice(0, cut) : raw;
    if (qAt >= 0) {
      const qs = raw.slice(qAt + 1, hAt > qAt ? hAt : undefined);
      query = new URLSearchParams(qs);
    }
    if (hAt >= 0 && (qAt < 0 || hAt < qAt || hAt > qAt)) {
      section = raw.slice(hAt + 1);
    }
    raw = pathPart;
  } else {
    raw = location.pathname.replace(/\/index\.html$/, '/');
    if (location.hash && !location.hash.startsWith('#/')) section = location.hash.slice(1);
  }
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p.split('?')[0]); } catch { return p.split('?')[0]; }
  });
  return { parts, section, query };
}

function routeFromParts(parts) {
  if (parts.length === 0) return { view: Home, title: 'ScionHub' };
  if (parts.length === 1 && parts[0] === 'getting-started') return { view: GettingStarted, title: 'Getting started — ScionHub' };
  if (parts.length === 1 && parts[0] === 'login') return LoginView();
  if (parts.length === 1 && parts[0] === 'new') return NewRepoView();
  if (parts.length === 1) {
    const v = OrgView(parts[0]);
    v.title = `${parts[0]} — ScionHub`;
    return v;
  }
  const org = parts[0];
  const repo = parts[1];
  const title = `${org}/${repo} — ScionHub`;
  if (parts.length === 2) return Object.assign(RepoView(org, repo, { tab: 'code', kind: 'tree', ref: 'main', path: '' }), { title });
  const third = parts[2];
  if (third === 'pulls') {
    return Object.assign(RepoView(org, repo, { tab: 'pulls', pull: parts[3] || null }), { title });
  }
  if (third === 'sync') {
    return Object.assign(RepoView(org, repo, { tab: 'sync' }), { title });
  }
  if (third === 'tree' || third === 'blob') {
    const ref = parts[3] || 'main';
    const path = parts.slice(4).join('/');
    return Object.assign(RepoView(org, repo, { tab: 'code', kind: third, ref, path }), { title });
  }
  return { view: NotFound, title: 'Not found — ScionHub' };
}

function navHrefActive(href) {
  const now = location.hash.startsWith('#/') ? '/#/' + location.hash.slice(2).split('/').filter(Boolean).slice(0, 2).join('/') : location.pathname;
  return href === location.hash || href === location.pathname || href === now || (href === '/#/getting-started' && location.hash.startsWith('#/getting-started'));
}

function drawNav() {
  const el = document.getElementById('nav-auth');
  if (!el) return;
  const a = getAuth();
  const inner = a
    ? html`<a class="btn btn-primary" href="/#/new">New</a><span class="nav-user">${a.username}</span><button class="btn btn-ghost" type="button" @click=${() => { setAuth(null); if (location.hash.startsWith('#/new') || location.hash.startsWith('#/login')) navigate('/#/'); else draw(); }}>Log out</button>`
    : html`<a class="btn btn-ghost" href="/#/login">Sign in</a>`;
  render(inner, el);
}

function route() {
  const key = location.pathname + location.hash;
  if (key === lastKey && current) return;
  lastKey = key;
  const { parts, section } = parseLocation();
  current = routeFromParts(parts);
  document.title = current.title || (
    parts[0] === 'login' ? 'Sign in — ScionHub'
      : parts[0] === 'new' ? 'New repository — ScionHub'
        : 'ScionHub'
  );
  document.querySelectorAll('#site-nav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    a.toggleAttribute('aria-current', navHrefActive(href));
  });
  drawNav();
  draw();
  if (current.load) current.load(draw);
  if (section) document.getElementById(section)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

function navigate(url) {
  const u = new URL(url, location.href);
  if (u.pathname === location.pathname && u.hash === location.hash && u.search === location.search) {
    lastKey = '';
    route();
    return;
  }
  history.pushState(null, '', u);
  lastKey = '';
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('data-external') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || /\.\w+$/.test(u.pathname)) return;
  e.preventDefault();
  const hashRoute = u.hash.startsWith('#/');
  const sectionHash = u.hash && !hashRoute;
  if (sectionHash && u.pathname === location.pathname && !location.hash.startsWith('#/')) {
    history.pushState(null, '', u);
    document.getElementById(u.hash.slice(1))?.scrollIntoView();
    return;
  }
  navigate(u);
});
let routeFrame = 0;
function routeSoon() {
  lastKey = '';
  if (routeFrame) cancelAnimationFrame(routeFrame);
  routeFrame = requestAnimationFrame(() => { routeFrame = 0; route(); });
}
window.addEventListener('popstate', routeSoon);
window.addEventListener('hashchange', routeSoon);
drawNav();
route();
