// ScionHub SPA: path + hash routing with lit-html. GitHub Pages serves 404.html
// (a copy of index.html) for unknown paths, so /org/repo and /#/org/repo both boot here.
import { html, render, nothing } from 'https://cdn.jsdelivr.net/npm/lit-html@3/lit-html.js';
import { unsafeHTML } from 'https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js';

const API = (window.SCIONHUB_API_BASE || 'https://openscion-filecoin-poc.jolly-bush-400d.workers.dev').replace(/\/$/, '');
const FALLBACK = { orgs: ['filecoin-project'], repos: { 'filecoin-project': ['curio', 'lotus'] } };
const DATASET = '46121';
const AUTH_KEY = 'scionhub.auth';
const ENV = `export OPENSCION_SERVER=${API}`;
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/* ---------- session ---------- */
function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
  catch { return null; }
}
function setAuth(value) {
  if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
  else localStorage.removeItem(AUTH_KEY);
  renderNav();
}

/* ---------- routing helpers ---------- */
function link(...parts) {
  const segs = parts.filter((p) => p !== undefined && p !== null && p !== '')
    .flatMap((p) => String(p).split('/'))
    .filter(Boolean)
    .map(encodeURIComponent);
  return '/#/' + segs.join('/');
}
function parseLocation() {
  const hash = location.hash || '';
  let path = '';
  let query = new URLSearchParams(location.search);
  let fragment = '';
  if (hash.startsWith('#/')) {
    const raw = hash.slice(1);
    const qAt = raw.indexOf('?');
    const hashPart = qAt >= 0 ? raw.slice(0, qAt) : raw;
    const qs = qAt >= 0 ? raw.slice(qAt + 1) : '';
    const hashFrag = hashPart.indexOf('#', 1);
    path = (hashFrag >= 0 ? hashPart.slice(0, hashFrag) : hashPart).replace(/\/+$/, '') || '/';
    fragment = hashFrag >= 0 ? hashPart.slice(hashFrag + 1) : '';
    if (qs) query = new URLSearchParams(qs);
  } else {
    path = location.pathname.replace(/\/index\.html$/, '/');
    fragment = hash.startsWith('#') ? hash.slice(1) : '';
  }
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, parts, query, fragment };
}

/* ---------- API ---------- */
async function apiFetch(path, { method = 'GET', body, auth = true, accept } = {}) {
  const headers = { accept: accept || 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const tok = getAuth()?.token;
  if (auth && tok) headers.authorization = `Bearer ${tok}`;
  return fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function getJSON(path) {
  const r = await apiFetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function tryGet(path, fallback) {
  try { return { data: await getJSON(path), live: true }; }
  catch (e) { return { data: fallback, live: false, error: String(e.message || e) }; }
}
async function readError(r) {
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    return j.error || j.message || text || `HTTP ${r.status}`;
  } catch { return text || `HTTP ${r.status}`; }
}
const srcTag = (s) => s ? html`<span class="src-tag" title=${s.live ? 'Fetched live from the ScionHub API' : `Live fetch failed (${s.error}); showing fallback.`}>${s.live ? 'live' : 'fallback'}</span>` : nothing;
const pre = (lines) => html`<pre><code>${lines.join('\n')}</code></pre>`;

function enc(s) { return encodeURIComponent(s); }
function repoBase(org, repo) { return `/v1/repos/${enc(org)}/${enc(repo)}`; }

function formatTime(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return String(ms);
  const delta = Date.now() - d.getTime();
  const sec = Math.round(delta / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleString();
}
function shortId(id) { return id ? String(id).slice(0, 7) : ''; }
function formatSize(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}
function isDirKind(kind) {
  const k = String(kind || '').toLowerCase();
  return k === 'tree' || k === 'dir' || k === 'directory';
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}
function decodeFrames(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const frames = [];
  let i = 0;
  while (i + 40 <= u8.length) {
    const id = bytesToHex(u8.subarray(i, i + 32));
    const len = Number(view.getBigUint64(i + 32));
    i += 40;
    const body = u8.subarray(i, i + len);
    i += len;
    frames.push({ id, body });
  }
  return frames;
}
function decodeTree(body) {
  const kinds = { 102: 'file', 120: 'executable', 108: 'symlink', 100: 'tree' };
  const entries = [];
  const u8 = body;
  let i = 0;
  const dec = new TextDecoder();
  while (i < u8.length) {
    const kind = kinds[u8[i]] || 'file';
    i += 1;
    let z = i;
    while (z < u8.length && u8[z] !== 0) z += 1;
    const name = dec.decode(u8.subarray(i, z));
    i = z + 1;
    const id = bytesToHex(u8.subarray(i, i + 32));
    i += 32;
    entries.push({ name, kind, id });
  }
  return entries;
}

async function postObjects(org, repo, ids) {
  const r = await apiFetch(`${repoBase(org, repo)}/objects`, {
    method: 'POST',
    body: { ids },
    auth: false,
    accept: 'application/octet-stream',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function resolvePieces(org, repo, ids) {
  const r = await apiFetch(`${repoBase(org, repo)}/objects/resolve`, {
    method: 'POST',
    body: { ids },
    auth: false,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.results || [];
}
async function rangeGet(url, offset, length) {
  const a = Number(offset);
  const b = a + Number(length) - 1;
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function splitRefPath(rest, branches, fallback = 'main') {
  const names = (branches || [])
    .map((b) => (typeof b === 'string' ? b : b.name))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const joined = rest.join('/');
  for (const name of names) {
    if (joined === name || joined.startsWith(`${name}/`)) {
      return { ref: name, path: joined.slice(name.length).replace(/^\//, '') };
    }
  }
  if (!rest.length) return { ref: fallback, path: '' };
  return { ref: rest[0], path: rest.slice(1).join('/') };
}

function pcidMap(changeset) {
  const meta = changeset?.metadata || {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith('pcid:')) out[k.slice(5)] = v;
  }
  return out;
}

async function loadChangeset(org, repo, id) {
  return getJSON(`${repoBase(org, repo)}/changesets/${enc(id)}`);
}

async function fetchTreeEntries(org, repo, ref, dirPath, changeset) {
  const q = dirPath ? `?path=${enc(dirPath)}` : '';
  try {
    const r = await apiFetch(`${repoBase(org, repo)}/tree/${enc(ref)}${q}`, { auth: false });
    if (r.ok) {
      const j = await r.json();
      const entries = j.entries || (Array.isArray(j) ? j : []);
      return { entries, live: true, via: 'tree' };
    }
  } catch { /* fallback */ }

  if (changeset?.root_tree) {
    try {
      let treeId = changeset.root_tree;
      const segs = dirPath ? dirPath.split('/').filter(Boolean) : [];
      for (const seg of segs) {
        const frames = decodeFrames(await postObjects(org, repo, [treeId]));
        const entries = decodeTree(frames[0]?.body || new Uint8Array());
        const hit = entries.find((e) => e.name === seg && isDirKind(e.kind));
        if (!hit) return { entries: [], live: true, via: 'objects' };
        treeId = hit.id;
      }
      const frames = decodeFrames(await postObjects(org, repo, [treeId]));
      const entries = decodeTree(frames[0]?.body || new Uint8Array());
      return { entries, live: true, via: 'objects' };
    } catch (e) {
      /* metadata fallback */
      const err = String(e.message || e);
      const files = Object.keys(pcidMap(changeset));
      const prefix = dirPath ? `${dirPath.replace(/\/$/, '')}/` : '';
      const kids = new Map();
      for (const p of files) {
        if (prefix && !p.startsWith(prefix)) continue;
        const rest = prefix ? p.slice(prefix.length) : p;
        if (!rest) continue;
        const name = rest.split('/')[0];
        const isDir = rest.includes('/');
        if (!kids.has(name)) kids.set(name, { name, kind: isDir ? 'tree' : 'file', pieceCid: isDir ? undefined : pcidMap(changeset)[p] });
      }
      return { entries: [...kids.values()], live: true, via: 'metadata', error: err };
    }
  }
  return { entries: [], live: false, error: 'tree unavailable' };
}

function looksBinary(bytes, name = '') {
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|wasm|bin|so|dylib|exe|woff2?|ttf|otf)$/i.test(name)) return true;
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    dec.decode(bytes.subarray(0, n));
    return false;
  } catch { return true; }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchBlobBytes(org, repo, ref, filePath, changeset) {
  const hint = { url: null, offset: null, length: null, pieceCid: null, size: null, error: null };
  try {
    const r = await apiFetch(`${repoBase(org, repo)}/blob/${enc(ref)}?path=${enc(filePath)}`, { auth: false });
    if (r.ok) {
      const j = await r.json();
      hint.pieceCid = j.pieceCid || null;
      hint.url = j.url || null;
      hint.offset = j.offset;
      hint.length = j.length;
      hint.size = j.size ?? j.length;
      if (hint.url && hint.length != null) {
        try {
          const bytes = await rangeGet(hint.url, hint.offset, hint.length);
          return { bytes, hint, via: 'sp' };
        } catch (e) {
          hint.error = String(e.message || e);
          return { bytes: null, hint, via: 'sp-failed' };
        }
      }
      if (j.contentBase64) return { bytes: b64ToBytes(j.contentBase64), hint, via: 'base64' };
    }
  } catch { /* fallback */ }
  if (!hint.url) {
    const pcid = pcidMap(changeset)[filePath];
    if (pcid) {
      hint.pieceCid = pcid;
      try {
        const results = await resolvePieces(org, repo, [pcid]);
        const hit = results.find((x) => x.pieceCid === pcid) || results[0];
        if (hit) {
          hint.url = hit.url;
          hint.offset = hit.offset;
          hint.length = hit.length;
          hint.size = hit.length;
        }
      } catch (e) { hint.error = String(e.message || e); }
    }
  }
  if (hint.url && hint.length != null) {
    try {
      const bytes = await rangeGet(hint.url, hint.offset, hint.length);
      return { bytes, hint, via: 'sp' };
    } catch (e) {
      hint.error = String(e.message || e);
      return { bytes: null, hint, via: 'sp-failed' };
    }
  }
  // Last resort: object frames by blob id from the tree walk (no SP).
  try {
    if (changeset?.root_tree) {
      let treeId = changeset.root_tree;
      const segs = filePath.split('/').filter(Boolean);
      const file = segs.pop();
      for (const seg of segs) {
        const frames = decodeFrames(await postObjects(org, repo, [treeId]));
        const entries = decodeTree(frames[0]?.body || new Uint8Array());
        const hit = entries.find((e) => e.name === seg);
        if (!hit) break;
        treeId = hit.id;
      }
      const frames = decodeFrames(await postObjects(org, repo, [treeId]));
      const entries = decodeTree(frames[0]?.body || new Uint8Array());
      const hit = entries.find((e) => e.name === file);
      if (hit && !isDirKind(hit.kind)) {
        const blobFrames = decodeFrames(await postObjects(org, repo, [hit.id]));
        const body = blobFrames[0]?.body;
        if (body) return { bytes: body, hint, via: 'objects' };
      }
    }
  } catch (e) {
    hint.error = hint.error || String(e.message || e);
  }
  return { bytes: null, hint, via: 'none' };
}

/* ---------- markdown (escape first) ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function mdInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}
function mdToHtml(src) {
  const lines = String(src ?? '').split(/\r?\n/);
  let htmlOut = '';
  let inCode = false;
  let inList = false;
  const closeList = () => { if (inList) { htmlOut += '</ul>'; inList = false; } };
  for (const line of lines) {
    if (inCode) {
      if (/^```/.test(line)) { htmlOut += '</code></pre>'; inCode = false; }
      else htmlOut += `${escapeHtml(line)}\n`;
      continue;
    }
    if (/^```/.test(line)) { closeList(); htmlOut += '<pre><code>'; inCode = true; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length;
      htmlOut += `<h${n}>${mdInline(escapeHtml(h[2]))}</h${n}>`;
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { htmlOut += '<ul>'; inList = true; }
      htmlOut += `<li>${mdInline(escapeHtml(li[1]))}</li>`;
      continue;
    }
    if (line.trim() === '') { closeList(); continue; }
    closeList();
    htmlOut += `<p>${mdInline(escapeHtml(line))}</p>`;
  }
  if (inCode) htmlOut += '</code></pre>';
  closeList();
  return htmlOut;
}

function copyText(text) {
  const done = () => {};
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done).catch(done);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}

function CopyBox(cmd, state, key) {
  return html`<div class="clone-box">
    <code>${cmd}</code>
    <button type="button" @click=${() => { copyText(cmd); state.copied = key; draw(); setTimeout(() => { if (state.copied === key) { state.copied = ''; draw(); } }, 1200); }}>${state.copied === key ? 'Copied' : 'Copy'}</button>
  </div>`;
}

/* ---------- views ---------- */
const Home = () => html`
  <section class="hero"><div class="container hero-inner">
    <div class="hero-copy">
      <h1>Agent‑scale monorepo.<br />Verifiable storage.<br />Zero infra to run.</h1>
      <p class="lede">ScionHub hosts <strong>OpenScion</strong> with repository content stored on
        <strong>Filecoin</strong> via <strong>PDP</strong> (Proof of Data Possession). Every stored piece is
        addressed by its <strong>PieceCID</strong> and read back <strong>directly from the storage provider</strong>.
        GitHub‑like orgs and repos — first org: <a href=${link('filecoin-project')}><em>filecoin-project</em></a>.</p>
      <p class="disclaimer">This is a <strong>proof of concept</strong>. Keep expectations realistic; we keep claims honest.</p>
      <div class="hero-cta">
        <a class="btn btn-primary btn-lg" href="${link('getting-started')}#import">Import your repo</a>
        <a class="btn btn-ghost btn-lg" href=${link('filecoin-project')}>Browse filecoin-project</a>
        <a class="btn btn-ghost btn-lg" href=${link('getting-started')}>Getting started</a>
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
      <article class="card"><h3>Bring your code</h3><p>One command imports an existing directory: <code>opnscn import</code>. <a href="${link('getting-started')}#import">How to import →</a></p></article>
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
    <p class="tiny-note">Every command below is checked against <code>opnscn --help</code> from <a href="https://github.com/scionhub/openscion" target="_blank" rel="noopener">scionhub/openscion</a>. <a href="/cli.html" data-external>Download the CLI</a>.</p></div></div>
  <div class="page"><div class="container docs-content">
    <h2 id="setup">1. Point the CLI at ScionHub</h2>
    <p>Every command also accepts <code>--server &lt;URL&gt;</code>.</p>
    ${pre([ENV, 'opnscn server-info'])}

    <h2 id="account">2. Create an account (needed for writes)</h2>
    <p>Username must match <code>^[a-z0-9][a-z0-9-]{2,31}$</code>; password at least 10 characters. You can also <a href=${link('login')}>sign up in the browser</a>.</p>
    ${pre(['opnscn signup --username <you> --email <you@example.com>', '# later, on another machine:', 'opnscn login --user <you>'])}

    <h2 id="create-repo">3. Create a repository</h2>
    <p>Logged-in users can create a public repo under their own username (the user-namespace org) or an org they belong to. On the web: <a href=${link('new')}>New repository</a>. Repos on the free tier are kept for <strong>60 days</strong> unless you follow the pay prompt (POC checkout; no charges).</p>
    ${pre(['opnscn repo create <name>', 'opnscn repo create <name> --org <org>'])}

    <h2 id="import">4. Import / push your first content</h2>
    <p><code>opnscn import</code> records a directory as the repository's first changeset, creates the ref, and turns the directory into a working copy. Content is stored on Filecoin and addressed by PieceCID.</p>
    ${pre(['opnscn import ./src --repo <org>/<repo>', 'opnscn import . --repo <org>/<repo> --ref main -m "initial import" --author <you>'])}
    <p>From an existing working copy, or after the import:</p>
    ${pre(['opnscn commit -m "first" --ref main'])}

    <h2 id="clone">5. Clone an existing repo</h2>
    <p>Public-repo reads need no account.</p>
    ${pre(['opnscn clone ./curio --repo filecoin-project/curio', 'opnscn clone ./curio --repo filecoin-project/curio --ref main', 'opnscn clone ./curio --repo filecoin-project/curio --path src'])}

    <h2 id="branch">6. Branch, commit, open a PR</h2>
    <p>Org members can move any ref. Anyone logged in can push under <code>refs/heads/users/&lt;username&gt;/*</code> on a public repo.</p>
    ${pre(['cd curio', '# edit files, then publish to refs/heads/users/<you>/my-feature', 'opnscn branch push my-feature -m "my change"', 'opnscn pr create --title "My change" --head refs/heads/users/<you>/my-feature --base main', 'opnscn pr list', 'opnscn pr show <number>', 'opnscn pr merge <number>   # org member or admin; fast-forward'])}

    <h2 id="sync">7. Sync workflow</h2>
    <p><code>opnscn sync</code> three-way-merges the working copy with a target ref (default <code>main</code>), including uncommitted edits. Conflicts are written with git-style markers. After resolving, commit (the next changeset uses the synced-from tip as first parent so a PR can fast-forward) and push the branch.</p>
    ${pre([
      'opnscn clone ./work --repo <org>/<repo>',
      'cd work',
      'opnscn branch push feature',
      '# ... meanwhile main moved; edit files, then:',
      'opnscn sync',
      'opnscn sync --from main --dir .',
    ])}
    <p>A conflicted file looks like:</p>
    <pre class="conflict-sample"><code><span class="mark">&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</span>
the line as it is on your branch
=======
the line as it is on main
<span class="mark">&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</span></code></pre>
    <p>Edit the file to the resolved contents (remove the markers), then:</p>
    ${pre([
      'opnscn commit -m "merge main"',
      'opnscn branch push feature',
      'opnscn pr create --title "Feature" --head refs/heads/users/<you>/feature',
      'opnscn pr merge 1',
    ])}

    <h2>Browse</h2><p>See <a href=${link('filecoin-project')}>filecoin-project repositories</a> — start with <a href=${link('filecoin-project', 'curio')}>filecoin-project/curio</a>.</p>
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
          : s.data.length ? s.data.map((r) => html`<li class="repo-item"><a href=${link(org, r)}><strong>${org}/${r}</strong></a><span class="badge">public</span></li>`)
          : html`<li class="repo-item"><span class="muted">No repositories yet.</span></li>`}</ul>
        <p class="tiny-note">Have code to bring? <a href="${link('getting-started')}#import">Import it with <code>opnscn import</code></a>.</p>
      </section>
    </div></div>`;
  return { view: () => view(st.s), load: async (rerender) => {
    st.s = await tryGet(`/v1/orgs/${enc(org)}/repos`, FALLBACK.repos[org] || []);
    if (st.s.live && !Array.isArray(st.s.data)) st.s.data = st.s.data.repos || [];
    st.s.data = st.s.data.map((r) => (typeof r === 'string' ? r : r.name));
    rerender();
  } };
};

function kindLabel(kind) {
  const k = String(kind || 'file').toLowerCase();
  if (isDirKind(k)) return 'dir';
  if (k === 'symlink' || k === 'link') return 'symlink';
  if (k === 'executable' || k === 'exec') return 'exec';
  return 'file';
}

const RepoView = (org, repo, opts) => {
  const full = `${org}/${repo}`;
  const tab = opts.tab || 'code';
  const mode = opts.mode || 'tree';
  const st = {
    info: null,
    branches: null,
    refName: opts.ref || 'main',
    path: opts.path || '',
    commit: null,
    tree: null,
    blob: null,
    readme: null,
    pulls: null,
    pull: null,
    copied: '',
    changeset: null,
  };
  const cloneCmd = `opnscn clone ./${repo} --repo ${full}`;

  const goBranch = (name) => {
    history.pushState(null, '', link(org, repo, 'tree', name));
    route();
  };

  const breadcrumbs = () => {
    const segs = st.path.split('/').filter(Boolean);
    const crumbs = [{ name: repo, href: link(org, repo, 'tree', st.refName) }];
    let acc = '';
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ name: seg, href: link(org, repo, 'tree', st.refName, acc) });
    }
    if (mode === 'blob' && crumbs.length) crumbs[crumbs.length - 1].href = null;
    return html`<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => html`${i ? html`<span class="muted">/</span>` : nothing}${c.href ? html`<a href=${c.href}>${c.name}</a>` : html`<span>${c.name}</span>`}`)}</nav>`;
  };

  const branchSelect = () => {
    const list = st.branches?.data || [];
    const names = list.map((b) => (typeof b === 'string' ? b : b.name));
    if (!names.includes(st.refName)) names.unshift(st.refName);
    return html`<label class="branch-select">Branch
      <select aria-label="Branch" @change=${(e) => goBranch(e.target.value)}>
        ${names.map((n) => html`<option value=${n} ?selected=${n === st.refName}>${n}</option>`)}
      </select>
    </label>`;
  };

  const commitBar = () => {
    const c = st.commit;
    if (!c) return html`<div class="commit-bar"><span class="muted">Loading latest commit…</span></div>`;
    if (c.error && !c.id) return html`<div class="commit-bar"><span class="muted">Commit info unavailable</span></div>`;
    return html`<div class="commit-bar">
      <span class="msg">${c.message || '(no message)'}</span>
      <span class="muted">${c.author || ''}</span>
      <span class="muted">${formatTime(c.created_at)}</span>
      <span class="mono" title=${c.id || ''}>${shortId(c.id)}</span>
    </div>`;
  };

  const fileTable = () => {
    if (!st.tree) return html`<p class="muted">Loading files…</p>`;
    const entries = [...(st.tree.entries || [])].sort((a, b) => {
      const da = isDirKind(a.kind) ? 0 : 1;
      const db = isDirKind(b.kind) ? 0 : 1;
      if (da !== db) return da - db;
      return String(a.name).localeCompare(String(b.name));
    });
    if (!entries.length) {
      return html`<p class="muted">${st.tree.live === false
        ? html`No files on this ref yet. Import with <code>opnscn import . --repo ${full}</code>.`
        : 'This directory is empty.'}</p>`;
    }
    const parent = st.path.split('/').filter(Boolean).slice(0, -1).join('/');
    return html`<table class="file-table">
      <tbody>
        ${st.path ? html`<tr><td class="kind">dir</td><td><a href=${link(org, repo, 'tree', st.refName, parent)}>..</a></td><td class="size"></td></tr>` : nothing}
        ${entries.map((e) => {
          const child = st.path ? `${st.path}/${e.name}` : e.name;
          const href = isDirKind(e.kind) ? link(org, repo, 'tree', st.refName, child) : link(org, repo, 'blob', st.refName, child);
          return html`<tr>
            <td class="kind">${kindLabel(e.kind)}</td>
            <td><a href=${href}>${e.name}</a></td>
            <td class="size">${e.size != null ? formatSize(e.size) : ''}</td>
          </tr>`;
        })}
      </tbody>
    </table>`;
  };

  const spHint = (hint) => hint?.url ? html`<div class="tiny-note">Storage provider: <a href=${hint.url} data-external target="_blank" rel="noopener">${hint.url}</a>${hint.offset != null && hint.length != null ? html` · <code>Range: bytes=${hint.offset}-${Number(hint.offset) + Number(hint.length) - 1}</code>` : nothing}</div>` : nothing;
  const blobView = () => {
    if (!st.blob) return html`<p class="muted">Loading file…</p>`;
    const { bytes, hint } = st.blob;
    if (!bytes) {
      return html`<div class="card binary-note">
        <p>Could not fetch file bytes${hint?.error ? html`: ${hint.error}` : nothing}.</p>
        ${spHint(hint)}
        ${hint?.pieceCid ? html`<p class="tiny-note">PieceCID <code class="mono">${hint.pieceCid}</code></p>` : nothing}
      </div>`;
    }
    if (looksBinary(bytes, st.path)) {
      return html`<div class="card binary-note">
        <p>Binary file · ${formatSize(bytes.length)}</p>
        ${hint?.url ? html`<p><a class="btn" href=${hint.url} data-external target="_blank" rel="noopener">Raw piece URL</a></p>` : nothing}
        ${spHint(hint)}
      </div>`;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const lines = text.split(/\n/);
    return html`<div class="blob-frame"><table class="blob-table" aria-label="File contents"><tbody>
        ${lines.map((line, i) => html`<tr><td class="ln">${i + 1}</td><td class="src">${line}</td></tr>`)}
      </tbody></table></div>`;
  };

  const readmeView = () => {
    if (mode !== 'tree') return nothing;
    if (!st.readme) return nothing;
    if (st.readme.missing) return nothing;
    if (!st.readme.bytes) return html`<div class="readme-wrap card"><h2>README</h2><p class="muted">README found but could not be fetched.</p></div>`;
    if (looksBinary(st.readme.bytes, st.readme.name)) return nothing;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(st.readme.bytes);
    const isMd = /\.md$/i.test(st.readme.name);
    return html`<div class="readme-wrap card">
      <h2>${st.readme.name}</h2>
      ${isMd ? html`<div class="md-body">${unsafeHTML(mdToHtml(text))}</div>` : html`<pre><code>${text}</code></pre>`}
    </div>`;
  };

  const codeTab = () => html`
    <div class="file-toolbar">
      ${branchSelect()}
      ${CopyBox(cloneCmd, st, 'clone')}
    </div>
    ${breadcrumbs()}
    ${mode === 'blob' ? blobView() : html`
      ${commitBar()}
      ${fileTable()}
      ${readmeView()}
    `}`;

  const pullsTab = () => {
    if (opts.pullNumber) {
      const p = st.pull;
      if (!p) return html`<p class="muted">Loading pull request…</p>`;
      if (!p.live) return html`<p class="muted">Could not load PR #${opts.pullNumber}.</p>`;
      const d = p.data;
      const keys = Object.keys(d || {});
      return html`
        <p><a href=${link(org, repo, 'pulls')}>← Pull requests</a></p>
        <h2>#${d.number} ${d.title || ''}</h2>
        <div class="card"><dl class="kv">${keys.map((k) => html`<dt>${k}</dt><dd class="mono">${d[k] == null ? '' : typeof d[k] === 'object' ? JSON.stringify(d[k]) : String(d[k])}</dd>`)}</dl></div>`;
    }
    const pulls = st.pulls;
    const list = pulls && (Array.isArray(pulls.data) ? pulls.data : pulls.data.pulls || []);
    const open = (list || []).filter((p) => !p.state || p.state === 'open');
    return html`
      <h3 style="margin-top:0">Open pull requests ${pulls ? srcTag(pulls) : nothing}</h3>
      ${!pulls ? html`<p class="muted">Loading…</p>` : !pulls.live ? html`<p class="muted">Couldn't load pull requests. Run <code>opnscn pr list --repo ${full}</code>.</p>`
        : open.length ? html`<ul class="repo-list">${open.map((p) => html`<li class="repo-item pr-item">
            <a href=${link(org, repo, 'pulls', p.number)}><strong>#${p.number} ${p.title}</strong></a>
            <span class="badge">${p.state || 'open'}</span>
            <span class="pr-meta">${p.author || p.author_name || 'unknown'} · ${p.head || p.head_ref || ''} → ${p.base || p.base_ref || ''} · ${formatTime(p.created_at)}</span>
          </li>`)}</ul>`
        : html`<p class="muted">No open pull requests.</p>`}`;
  };

  const syncTab = () => html`
    <div class="card cli-panel">
      <h3 style="margin-top:0">Sync this repo</h3>
      <p>Branch, edit, <code>opnscn sync</code> against <code>main</code>, resolve markers, commit, push, and open a PR.</p>
      ${pre([
        ENV,
        `opnscn clone ./${repo} --repo ${full}`,
        `cd ${repo}`,
        'opnscn branch push my-feature -m "start feature"',
        '# edit files',
        'opnscn sync                  # three-way merge from --from main',
        '# resolve conflict markers if any, then:',
        'opnscn commit -m "synced with main"',
        'opnscn branch push my-feature',
        `opnscn pr create --repo ${full} --title "My change" --head refs/heads/users/<you>/my-feature --base main`,
        `opnscn pr merge --repo ${full} <number>`,
      ])}
      <p>Conflict markers look like this:</p>
      <pre class="conflict-sample"><code><span class="mark">&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</span>
your edits
=======
upstream from main
<span class="mark">&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</span></code></pre>
      <p class="tiny-note"><a href="${link('getting-started')}#sync">Full getting-started sync section</a> · <a href="/cli.html" data-external>Get opnscn</a></p>
    </div>`;

  const view = () => html`
    <div class="page-head"><div class="container repo-head">
      <div class="tiny-note"><a href=${link(org)}>${org}</a> /</div>
      <div class="repo-title">
        <h1><a href=${link(org, repo)}>${repo}</a> <span class="badge">${st.info?.data?.visibility || 'public'}</span></h1>
        ${st.info ? srcTag(st.info) : nothing}
      </div>
      ${st.info?.live && st.info.data.created_at ? html`<div class="tiny-note">Created ${new Date(st.info.data.created_at).toLocaleDateString()}</div>` : nothing}
    </div></div>
    <div class="page"><div class="container">
      <nav class="repo-tabs" aria-label="Repository">
        <a href=${link(org, repo)} aria-current=${tab === 'code' ? 'page' : nothing}>Code</a>
        <a href=${link(org, repo, 'pulls')} aria-current=${tab === 'pulls' ? 'page' : nothing}>Pull requests</a>
        <a href=${link(org, repo, 'sync')} aria-current=${tab === 'sync' ? 'page' : nothing}>Sync</a>
      </nav>
      ${tab === 'pulls' ? pullsTab() : tab === 'sync' ? syncTab() : codeTab()}
    </div></div>`;

  return {
    view,
    load: async (rerender) => {
      const b = repoBase(org, repo);
      tryGet(b, { org, name: repo, visibility: 'public' }).then((s) => { st.info = s; rerender(); });

      const br = await tryGet(`${b}/branches`, { branches: [{ name: 'main' }] });
      const branchList = br.live
        ? (Array.isArray(br.data) ? br.data : br.data.branches || [])
        : [{ name: 'main' }];
      st.branches = { ...br, data: branchList };
      if (opts.refRest) {
        const split = splitRefPath(opts.refRest, branchList, opts.ref || 'main');
        st.refName = split.ref;
        st.path = split.path;
      }
      rerender();

      if (tab === 'pulls') {
        if (opts.pullNumber) {
          st.pull = await tryGet(`${b}/pulls/${enc(opts.pullNumber)}`, null);
          rerender();
        } else {
          st.pulls = await tryGet(`${b}/pulls`, { pulls: [] });
          rerender();
        }
        return;
      }
      if (tab === 'sync') return;

      let target = null;
      const ref = await tryGet(`${b}/refs/${st.refName}`, null);
      if (ref.live && ref.data?.target) target = ref.data.target;

      let commit = null;
      try {
        const cr = await apiFetch(`${b}/commits/${enc(st.refName)}?limit=20`, { auth: false });
        if (cr.ok) {
          const j = await cr.json();
          const list = j.commits || j.changesets || (Array.isArray(j) ? j : []);
          commit = list[0] || null;
          if (commit) {
            st.commit = {
              id: commit.id || commit.sha || target,
              message: commit.message,
              author: commit.author?.name || commit.author,
              created_at: commit.created_at || commit.timestamp,
            };
          }
        }
      } catch { /* fallback */ }

      if (target) {
        try {
          const cs = await loadChangeset(org, repo, target);
          st.changeset = cs;
          if (!st.commit) {
            st.commit = {
              id: cs.id || target,
              message: cs.message || cs.changeset?.message,
              author: cs.author || cs.changeset?.author,
              created_at: cs.created_at || cs.changeset?.created_at,
            };
          }
        } catch (e) {
          if (!st.commit) st.commit = { id: target, error: String(e.message || e) };
        }
      } else if (!st.commit) {
        st.commit = { error: ref.error || 'no ref' };
      }
      rerender();

      if (mode === 'blob') {
        st.blob = await fetchBlobBytes(org, repo, st.refName, st.path, st.changeset);
        rerender();
        return;
      }

      st.tree = await fetchTreeEntries(org, repo, st.refName, st.path, st.changeset);
      rerender();

      const readmeHit = (st.tree.entries || []).find((e) => !isDirKind(e.kind) && /^readme(\.md)?$/i.test(e.name));
      if (readmeHit) {
        const rpath = st.path ? `${st.path}/${readmeHit.name}` : readmeHit.name;
        const got = await fetchBlobBytes(org, repo, st.refName, rpath, st.changeset);
        st.readme = { name: readmeHit.name, bytes: got.bytes, hint: got.hint };
      } else {
        st.readme = { missing: true };
      }
      rerender();
    },
  };
};

const LoginView = (query) => {
  const st = { loginError: '', signupError: '', busy: false };
  const next = query.get('next') || link();
  const finish = (username, token) => {
    setAuth({ username, token });
    history.pushState(null, '', next.startsWith('/') ? next : link());
    route();
  };
  const onLogin = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    const password = String(fd.get('password') || '');
    st.busy = true; st.loginError = ''; draw();
    try {
      const r = await apiFetch('/v1/auth/login', { method: 'POST', body: { name, password }, auth: false });
      if (!r.ok) throw new Error(await readError(r));
      const j = await r.json();
      if (!j.token) throw new Error('no token in response');
      finish(name, j.token);
    } catch (err) {
      st.loginError = String(err.message || err);
      st.busy = false;
      draw();
    }
  };
  const onSignup = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = String(fd.get('username') || '').trim();
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    st.busy = true; st.signupError = ''; draw();
    if (!USERNAME_RE.test(username)) {
      st.signupError = 'Username must match ^[a-z0-9][a-z0-9-]{2,31}$';
      st.busy = false; draw(); return;
    }
    if (password.length < 10) {
      st.signupError = 'Password must be at least 10 characters';
      st.busy = false; draw(); return;
    }
    try {
      const body = { username, password };
      if (email) body.email = email;
      const r = await apiFetch('/v1/auth/signup', { method: 'POST', body, auth: false });
      if (!r.ok) throw new Error(await readError(r));
      const j = await r.json();
      if (!j.token) throw new Error('no token in response');
      finish(username, j.token);
    } catch (err) {
      st.signupError = String(err.message || err);
      st.busy = false;
      draw();
    }
  };
  const view = () => html`
    <div class="download-hero"><div class="container"><h1>Log in</h1>
      <p class="tiny-note">Writes (create repo, import, branch push, PRs) need an account. Reads of public repos do not.</p></div></div>
    <div class="page"><div class="container auth-grid">
      <form class="card form" @submit=${onLogin}>
        <h2>Log in</h2>
        <label for="login-name">Username</label>
        <input id="login-name" name="name" type="text" required autocomplete="username" />
        <label for="login-password">Password</label>
        <input id="login-password" name="password" type="password" required autocomplete="current-password" />
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>Log in</button></div>
        ${st.loginError ? html`<p class="form-error">${st.loginError}</p>` : nothing}
      </form>
      <form class="card form" @submit=${onSignup}>
        <h2>Create an account</h2>
        <label for="su-username">Username</label>
        <input id="su-username" name="username" type="text" required pattern="[a-z0-9][a-z0-9-]{2,31}" autocomplete="username" />
        <label for="su-email">Email (optional)</label>
        <input id="su-email" name="email" type="email" autocomplete="email" />
        <label for="su-password">Password</label>
        <input id="su-password" name="password" type="password" required minlength="10" autocomplete="new-password" />
        <p class="tiny-note">At least 10 characters. Signup is rate-limited.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>Sign up</button></div>
        ${st.signupError ? html`<p class="form-error">${st.signupError}</p>` : nothing}
      </form>
    </div></div>`;
  return { view };
};

const NewRepoView = () => {
  const auth = getAuth();
  const st = {
    owners: auth ? [auth.username] : [],
    error: '',
    created: null,
    busy: false,
    copied: '',
  };
  const view = () => {
    if (!auth) {
      return html`<div class="page"><div class="container narrow">
        <h1>New repository</h1>
        <p>You need to <a href=${link('login') + '?next=' + enc(link('new'))}>log in</a> to create a repository.</p>
      </div></div>`;
    }
    if (st.created) {
      const { org, name, retention } = st.created;
      const days = retention?.freeDays ?? 60;
      const payUrl = retention?.payUrl || '/checkout.html';
      const full = `${org}/${name}`;
      return html`<div class="page"><div class="container narrow">
        <h1>Repository created</h1>
        <p><strong>${full}</strong> is ready. It has no commits yet.</p>
        <div class="pay-prompt">
          <p><strong>Pay now so your repo isn't removed after ${days} days.</strong></p>
          <p class="tiny-note">Proof of concept: the checkout page explains pricing and <strong>does not charge</strong>.</p>
          <p><a class="btn btn-primary" href=${payUrl} data-external>Continue to checkout</a></p>
        </div>
        <p><a class="btn" href=${link(org, name)}>Open ${full}</a></p>
        <h3>Push first content</h3>
        ${pre([
          ENV,
          `opnscn import . --repo ${full}`,
          `opnscn import ./src --repo ${full}`,
        ])}
        <p class="tiny-note">Or create an empty directory, add files, and import from there. See <a href="${link('getting-started')}#import">Getting started</a>.</p>
      </div></div>`;
    }
    return html`<div class="page"><div class="container narrow">
      <h1>New repository</h1>
      <form class="card form" @submit=${onCreate}>
        <label for="repo-owner">Owner</label>
        <select id="repo-owner" name="org">${st.owners.map((o) => html`<option value=${o}>${o}</option>`)}</select>
        <label for="repo-name">Repository name</label>
        <input id="repo-name" name="name" type="text" required pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="my-repo" />
        <p class="tiny-note">Lowercase letters, numbers, dots, underscores, dashes. Created under <code>&lt;owner&gt;/&lt;name&gt;</code>.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>Create repository</button></div>
        ${st.error ? html`<p class="form-error">${st.error}</p>` : nothing}
      </form>
    </div></div>`;
  };
  async function onCreate(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    const org = String(fd.get('org') || auth.username).trim();
    if (!REPO_NAME_RE.test(name)) { st.error = 'Invalid repository name'; draw(); return; }
    st.busy = true; st.error = ''; draw();
    try {
      let r = await apiFetch('/v1/repos', { method: 'POST', body: { name, org } });
      if (r.status === 404 || r.status === 405) {
        r = await apiFetch(`/v1/repos/${enc(org)}/${enc(name)}`, { method: 'PUT', body: {} });
      }
      if (!r.ok) throw new Error(await readError(r));
      let data = {};
      const text = await r.text();
      if (text) {
        try { data = JSON.parse(text); } catch { data = {}; }
      }
      st.created = {
        org: data.org || org,
        name: data.name || data.repo || name,
        retention: data.retention || { freeDays: 60, payUrl: '/checkout.html' },
      };
    } catch (err) {
      st.error = String(err.message || err);
    }
    st.busy = false;
    draw();
  }
  return {
    view,
    load: async (rerender) => {
      if (!auth) return;
      const owners = new Set([auth.username]);
      const tryPaths = ['/v1/me', '/v1/me/orgs', `/v1/users/${enc(auth.username)}/orgs`];
      for (const p of tryPaths) {
        try {
          const r = await apiFetch(p);
          if (!r.ok) continue;
          const j = await r.json();
          const list = j.orgs || j.memberships || (Array.isArray(j) ? j : []);
          for (const item of list) {
            const id = typeof item === 'string' ? item : item.id || item.org || item.name;
            if (id && id !== 'filecoin-project') owners.add(id);
          }
          if (j.username && typeof j.username === 'string') owners.add(j.username);
        } catch { /* not available yet */ }
      }
      st.owners = [...owners];
      rerender();
    },
  };
};

const NotFound = () => html`<div class="page"><div class="container"><h1>Not found</h1><p><a href=${link()}>Back home</a></p></div></div>`;

/* ---------- nav + router ---------- */
const main = document.getElementById('main');
const navAuth = document.getElementById('nav-auth');
let current = null;

function NavAuth() {
  const auth = getAuth();
  if (auth?.username) {
    return html`
      <a class="btn btn-primary" href=${link('new')}>New repository</a>
      <span class="nav-user">@${auth.username}</span>
      <button type="button" class="btn btn-ghost" @click=${() => { setAuth(null); route(); }}>Log out</button>`;
  }
  return html`
    <a class="btn btn-ghost" href=${link('login')}>Log in</a>
    <a class="btn btn-primary" href="${link('getting-started')}#import">Import a repo</a>`;
}
function renderNav() {
  if (navAuth) render(NavAuth(), navAuth);
}

function draw() { render(current.view(), main); }

let routeGen = 0;
function route() {
  const loc = parseLocation();
  const parts = loc.parts;
  const gen = ++routeGen;
  let title = 'ScionHub';
  if (parts.length === 0) current = { view: Home };
  else if (parts[0] === 'getting-started' && parts.length === 1) { current = { view: GettingStarted }; title = 'Getting started — ScionHub'; }
  else if (parts[0] === 'login' && parts.length === 1) { current = LoginView(loc.query); title = 'Log in — ScionHub'; }
  else if (parts[0] === 'new' && parts.length === 1) { current = NewRepoView(); title = 'New repository — ScionHub'; }
  else if (parts.length === 1) { current = OrgView(parts[0]); title = `${parts[0]} — ScionHub`; }
  else if (parts.length >= 2) {
    const org = parts[0];
    const repo = parts[1];
    const rest = parts.slice(2);
    title = `${org}/${repo} — ScionHub`;
    if (rest[0] === 'pulls') {
      current = RepoView(org, repo, { tab: 'pulls', pullNumber: rest[1] });
    } else if (rest[0] === 'sync' && rest.length === 1) {
      current = RepoView(org, repo, { tab: 'sync' });
    } else if (rest[0] === 'tree') {
      current = RepoView(org, repo, { tab: 'code', mode: 'tree', refRest: rest.slice(1) });
    } else if (rest[0] === 'blob') {
      current = RepoView(org, repo, { tab: 'code', mode: 'blob', refRest: rest.slice(1) });
    } else if (rest.length === 0) {
      current = RepoView(org, repo, { tab: 'code', mode: 'tree', ref: 'main', path: '' });
    } else current = { view: NotFound };
  } else current = { view: NotFound };
  document.title = title;
  const logical = '/#/' + parts.map(encodeURIComponent).join('/');
  document.querySelectorAll('#site-nav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const on = href === logical || href === location.pathname || (parts.length === 0 && (href === '/' || href === '/#/' ));
    a.toggleAttribute('aria-current', on);
  });
  renderNav();
  draw();
  if (current.load) current.load(() => { if (gen === routeGen) draw(); });
  if (loc.fragment) document.getElementById(loc.fragment)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('data-external') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin) return;
  if (/\.\w+$/.test(u.pathname) && !u.hash.startsWith('#/')) return;
  const hashIsRoute = u.hash.startsWith('#/');
  const inPage = !hashIsRoute && u.pathname === location.pathname && u.hash;
  if (inPage) {
    e.preventDefault();
    history.pushState(null, '', u);
    document.getElementById(u.hash.slice(1))?.scrollIntoView();
    return;
  }
  if (!hashIsRoute && u.pathname === location.pathname && !u.hash) {
    e.preventDefault();
    history.pushState(null, '', u);
    route();
    return;
  }
  if (hashIsRoute || !/\.\w+$/.test(u.pathname)) {
    e.preventDefault();
    history.pushState(null, '', u);
    route();
  }
});
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
route();
