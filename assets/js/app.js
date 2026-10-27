// ScionBase SPA: client-side routing with lit-html.
// GitHub Pages serves 404.html (a copy of index.html) for unknown paths, so
// /filecoin-project/curio still boots this app. Hash routes (/#/org/repo/...)
// work on any static host without a fallback.
import { html, render, nothing } from 'https://cdn.jsdelivr.net/npm/lit-html@3/lit-html.js';
import { unsafeHTML } from 'https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15/+esm';
import purifyNs from 'https://cdn.jsdelivr.net/npm/dompurify@3/+esm';

const DOMPurify = purifyNs?.default || purifyNs;

const API = (window.SCIONBASE_API_BASE || 'https://api.scionbase.ai').replace(/\/$/, '');
const FALLBACK = { orgs: ['filecoin-project'], repos: { 'filecoin-project': ['curio', 'lotus'] } };
const DATASET = '46121';
const AUTH_KEY = 'scionbase.auth';
const OLD_AUTH_KEY = ['scion','hub.auth'].join('');
try { const o = localStorage.getItem(OLD_AUTH_KEY); if (o && !localStorage.getItem(AUTH_KEY)) localStorage.setItem(AUTH_KEY, o); localStorage.removeItem(OLD_AUTH_KEY); } catch {}
const ENV = `export SCN_SERVER=${API}`;
const RELEASE_TAG = 'scn-v0.3.0';
const RELEASE_PAGE = `https://github.com/scionhub/openscion/releases/tag/${RELEASE_TAG}`;
const RELEASE_ASSET = 'scn-x86_64-unknown-linux-gnu.tar.gz';
const RELEASE_ASSET_URL = `https://github.com/scionhub/openscion/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}`;
const assetUrl = (target) => `https://github.com/scionhub/openscion/releases/download/${RELEASE_TAG}/scn-${target}.tar.gz`;
const DOWNLOADS = [
  { label: 'macOS · Apple Silicon', note: 'M1 and newer (arm64)', target: 'aarch64-apple-darwin', mac: true },
  { label: 'macOS · Intel', note: 'x86_64', target: 'x86_64-apple-darwin', mac: true },
  { label: 'Linux x86_64', note: 'glibc', target: 'x86_64-unknown-linux-gnu' },
];
const README_NAMES = ['README.md', 'README', 'readme.md', 'Readme.md'];
const MAX_BLOB_BYTES = 512 * 1024;
const MAX_BLOB_LINES = 4000;
const MAX_DIFF_FILES = 40;
const MAX_DIFF_BYTES = 120 * 1024;
const DIFF_CONTEXT = 15;
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const ORG_NAME_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/* ---------- auth ---------- */
function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
  catch { return null; }
}
let meState = { data: null, loading: false, error: '' };
function getMe() { return meState.data; }
function setAuth(value) {
  if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
  else localStorage.removeItem(AUTH_KEY);
  meState = { data: null, loading: false, error: '' };
  if (value?.token) refreshMe();
  else drawNav();
}
async function refreshMe() {
  const a = getAuth();
  if (!a?.token) {
    meState = { data: null, loading: false, error: '' };
    drawNav();
    return null;
  }
  meState.loading = true;
  try {
    const data = await api('/v1/me', { auth: true });
    const user = data?.user || {};
    meState = { data, loading: false, error: '' };
    if (user.name && user.name !== a.username) {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ ...a, username: user.name }));
    }
    drawNav();
    draw();
    return data;
  } catch (e) {
    meState = {
      data: { user: { id: a.username, name: a.username, admin: false }, orgs: [] },
      loading: false,
      error: e.message || String(e),
    };
    drawNav();
    return meState.data;
  }
}
function meName() {
  return getMe()?.user?.name || getAuth()?.username || '';
}
function orgRole(org) {
  const me = getMe();
  if (!me) return '';
  if (me.user?.admin) return 'admin';
  for (const o of me.orgs || []) {
    const id = typeof o === 'string' ? o : o.id || o.name;
    if (id === org) return String(o.role || o.membership || (o.can_write ? 'member' : '') || '').toLowerCase();
  }
  return '';
}
function isOrgMember(org) {
  const role = orgRole(org);
  return role === 'member' || role === 'admin' || role === 'owner' || role === 'write';
}
function ownerChoices() {
  const auth = getAuth();
  const me = getMe();
  const out = [];
  const seen = new Set();
  const add = (id, role) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, role: role || '' });
  };
  const username = me?.user?.name || auth?.username;
  if (username) add(username, 'you');
  for (const o of me?.orgs || []) {
    const id = typeof o === 'string' ? o : o.id || o.name;
    const role = String(typeof o === 'string' ? 'member' : (o.role || '')).toLowerCase();
    if (id === 'filecoin-project' && !me?.user?.admin) continue;
    if (role && !['member', 'admin', 'owner', 'write', ''].includes(role)) continue;
    add(id, role);
  }
  return out;
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
async function tryGet(path, fallback, opts = {}) {
  try { return { data: await api(path, opts), live: true }; }
  catch (e) { return { data: fallback, live: false, error: String(e.message || e), status: e.status }; }
}

/** True when GET /v1/repos/:org/:repo says the repo does not exist (not merely unreachable). */
function isRepoNotFound(result) {
  if (!result || result.live) return false;
  if (result.status === 404) return true;
  const err = String(result.error || '').toLowerCase();
  return err === 'not found' || err === 'notfound';
}
const srcTag = () => nothing;

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
function pullUrl(org, repo, n, tab) {
  const extra = ['pulls', String(n)];
  if (tab === 'files') extra.push('files');
  else if (tab === 'conversation') extra.push('conversation');
  return repoUrl(org, repo, extra);
}
function userUrl(name) {
  return hashUrl(['u', name]);
}
function boardsUrl(org) {
  return hashUrl(['orgs', org, 'boards']);
}
function boardUrl(org, id) {
  return hashUrl(['orgs', org, 'boards', String(id)]);
}
function personName(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return String(obj).trim();
  return String(obj.user || obj.user_name || obj.author || obj.author_name || obj.name || obj.username || '').trim();
}
function userLink(name, fallback = 'unknown') {
  const n = String(name || '').trim();
  if (!n) return fallback;
  if (!USER_RE.test(n)) return n;
  return html`<a class="user-link" href=${userUrl(n)}>${n}</a>`;
}
function pullAuthorName(p) {
  return String(p?.author || p?.author_name || p?.user || p?.user_name || p?.username || '').trim() || 'unknown';
}
function pullStatusLabel(p) {
  if (!p) return 'open';
  if (p.merged === true || p.merged_at) return 'merged';
  const raw = String(p.state || 'open').toLowerCase();
  if (raw === 'merged') return 'merged';
  if (raw === 'closed') return 'closed';
  return 'open';
}
const TAGLINE_MAX = 200;
function extractTagline(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const nested = obj.user && typeof obj.user === 'object' ? obj.user : obj;
  const t = nested.tagline ?? nested.bio ?? obj.tagline ?? obj.bio ?? obj.profile?.tagline;
  return t == null ? '' : String(t);
}
function collectRepos(data, defaultOrg) {
  const raw = Array.isArray(data) ? data
    : Array.isArray(data?.repos) ? data.repos
      : Array.isArray(data?.ownedRepos) ? data.ownedRepos
        : Array.isArray(data?.owned_repos) ? data.owned_repos
          : [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const org = typeof r === 'string' ? defaultOrg : (r.org || r.owner || r.namespace || defaultOrg);
    const name = typeof r === 'string' ? r : (r.name || r.repo);
    if (!org || !name) continue;
    const key = `${org}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ org, name });
  }
  return out;
}
async function changeMyPassword({ currentPassword, newPassword }) {
  return api('/v1/auth/change-password', {
    method: 'POST',
    auth: true,
    body: { current_password: currentPassword, new_password: newPassword },
  });
}
async function patchMyProfile(body) {
  return api('/v1/me', { method: 'PATCH', auth: true, body });
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

// Parse a comma/space separated list of integers like "12, 15  20"
function parseNumberList(text) {
  if (!text) return [];
  return String(text)
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && /^\d+$/.test(t))
    .map((t) => parseInt(t, 10))
    .filter((n, i, a) => Number.isFinite(n) && a.indexOf(n) === i);
}
function shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? s.slice(0, 8) : s;
}
function entrySize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const n = entry.size ?? entry.bytes ?? entry.length ?? entry.size_bytes;
  return n == null || n === '' ? null : n;
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

function resolveRepoPath(u, dir) {
  const hash = u.includes('#') ? u.slice(u.indexOf('#')) : '';
  const clean = u.split('#')[0].split('?')[0];
  const segs = (dir ? dir.split('/') : []).filter(Boolean);
  for (const seg of clean.split('/')) {
    if (seg === '..') segs.pop();
    else if (seg && seg !== '.') segs.push(seg);
  }
  return { path: segs.join('/'), hash, trailingSlash: clean.endsWith('/') };
}
function absHttp(url) {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch { /* ignore */ }
  return null;
}
function mimeFromPath(path) {
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  })[ext] || 'application/octet-stream';
}

function rewriteReadmeHtml(rawHtml, ctx) {
  const doc = new DOMParser().parseFromString(`<div class="md-wrap">${rawHtml}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return { html: rawHtml, images: [] };
  const images = [];
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    if (href.startsWith('#') || href.startsWith('/#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const abs = absHttp(href);
      if (abs) {
        a.setAttribute('href', abs);
        a.setAttribute('rel', 'noopener');
        a.setAttribute('target', '_blank');
      } else a.removeAttribute('href');
      return;
    }
    if (href.startsWith('/')) return;
    const { path, hash, trailingSlash } = resolveRepoPath(href, ctx.dir);
    const next = (trailingSlash ? treeUrl(ctx.org, ctx.repo, ctx.ref, path) : blobUrl(ctx.org, ctx.repo, ctx.ref, path)) + hash;
    a.setAttribute('href', next);
  });
  root.querySelectorAll('img[src]').forEach((img, i) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src) return;
    if (/^https?:/i.test(src) || src.startsWith('data:')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) { img.remove(); return; }
    const { path } = resolveRepoPath(src, ctx.dir);
    const id = `md-img-${ctx.org}-${ctx.repo}-${i}`;
    img.setAttribute('id', id);
    img.setAttribute('data-repo-src', path);
    img.removeAttribute('src');
    images.push({ id, path });
  });
  return { html: root.innerHTML, images };
}

function sanitizeMarkdown(src) {
  let parsed = String(src ?? '');
  try { parsed = marked.parse(parsed, { gfm: true, breaks: false }); } catch { /* keep original */ }
  try {
    return DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['align', 'target', 'width', 'height', 'alt', 'id'],
    });
  } catch { return parsed; }
}

function applyImageUrls(body, jobs) {
  if (!jobs?.length) return body;
  const box = document.createElement('div');
  box.innerHTML = body;
  jobs.forEach((job) => {
    const el = box.querySelector(`[data-repo-src="${CSS.escape(job.path)}"]`);
    if (!el) return;
    if (job.url) el.setAttribute('src', job.url);
  });
  return box.innerHTML;
}

function renderMarkdown(src, ctx, imageJobs) {
  const { html: body, images } = rewriteReadmeHtml(sanitizeMarkdown(src), ctx);
  const htmlStr = applyImageUrls(body, imageJobs || images);
  return { template: html`<div class="md-body">${unsafeHTML(htmlStr)}</div>`, images };
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

async function fillMissingSizes(org, repo, ref, path, entries) {
  const missing = (entries || []).filter((e) => kindOf(e) !== 'dir' && entrySize(e) == null);
  await Promise.all(missing.slice(0, 80).map(async (e) => {
    const p = path ? `${path}/${e.name}` : e.name;
    try {
      const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/blob/${apiRef(ref)}?path=${encodeURIComponent(p)}`);
      if (data && (data.size != null || data.length != null)) e.size = data.size ?? data.length;
    } catch { /* keep empty */ }
  }));
}

async function loadTree(org, repo, ref, path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  try {
    const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${apiRef(ref)}${q}`);
    const entries = sortEntries(data.entries || []);
    if (entries.some((e) => kindOf(e) !== 'dir' && entrySize(e) == null)) {
      await fillMissingSizes(org, repo, ref, path, entries);
    }
    return { live: true, entries, data };
  } catch (e) {
    const { cs, refInfo } = await loadSnapshot(org, repo, ref);
    const entries = entriesFromChanges(cs, path);
    await fillMissingSizes(org, repo, ref, path, entries);
    return { live: false, fallback: true, error: e.message, entries, cs, refInfo };
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

function inlineBytesFromLoc(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const b64 = loc.contentBase64 || loc.content_base64;
  if (typeof b64 === 'string' && b64.length) return b64ToBytes(b64);
  if (loc.bytes instanceof Uint8Array && loc.bytes.length) return loc.bytes;
  if (typeof loc.content === 'string' && loc.content.length) return new TextEncoder().encode(loc.content);
  return null;
}

async function bytesFromHint(org, repo, hint) {
  const loc = { ...hint };
  // Blob payloads may include both contentBase64 and a pieceCid. Resolve can
  // 400 even when inline bytes are already present — use those first.
  const inline = inlineBytesFromLoc(loc);
  if (inline) return { bytes: inline, loc };
  if ((!loc.url || loc.offset == null) && loc.pieceCid) {
    Object.assign(loc, await resolvePiece(org, repo, loc.pieceCid));
  }
  const afterResolve = inlineBytesFromLoc(loc);
  if (afterResolve) return { bytes: afterResolve, loc };
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

async function hydrateReadmeImages(images, org, repo, ref) {
  if (!images?.length) return;
  await Promise.all(images.map(async (job) => {
    try {
      const blob = await loadBlob(org, repo, ref, job.path);
      let url = null;
      if (blob.bytes && blob.bytes.length) {
        url = URL.createObjectURL(new Blob([blob.bytes], { type: mimeFromPath(job.path) }));
      } else if (blob.loc?.url && (blob.loc.offset == null || blob.loc.offset === 0) && !blob.loc.length) {
        url = blob.loc.url;
      }
      job.url = url;
    } catch { job.url = null; }
  }));
}

function pcidMap(cs) {
  const out = {};
  const md = cs?.metadata || {};
  for (const [k, v] of Object.entries(md)) {
    if (k.startsWith('pcid:')) out[k.slice(5)] = v;
  }
  if (!Object.keys(out).length && Array.isArray(cs?.changes)) {
    for (const c of cs.changes) {
      if (!c?.path) continue;
      if (c.op === 'delete') out[c.path] = undefined;
      else out[c.path] = c.blob || c.id || c.pieceCid;
    }
  }
  return out;
}

function diffFilesFromMaps(baseMap, headMap) {
  const paths = new Set([...Object.keys(baseMap), ...Object.keys(headMap)]);
  const files = [];
  for (const path of [...paths].sort()) {
    const b = baseMap[path];
    const h = headMap[path];
    if (b === h) continue;
    if (h == null && !(path in headMap)) files.push({ path, status: 'removed' });
    else if (b == null && !(path in baseMap)) files.push({ path, status: 'added' });
    else if (h == null) files.push({ path, status: 'removed' });
    else if (b == null) files.push({ path, status: 'added' });
    else files.push({ path, status: 'modified' });
  }
  return files;
}

function fileStatus(f) {
  const s = String(f?.status || f?.op || f?.kind || '').toLowerCase();
  if (['added', 'add', 'create', 'created', 'new'].includes(s)) return 'added';
  if (['removed', 'remove', 'delete', 'deleted'].includes(s)) return 'removed';
  return 'modified';
}

// Line diff: trim the common prefix/suffix, then Myers O(ND) on the middle.
// Large files with small edits stay cheap; only very large rewrites fall back.
function lcsDiffLines(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  let pre = 0;
  while (pre < n && pre < m && aLines[pre] === bLines[pre]) pre += 1;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && aLines[n - 1 - suf] === bLines[m - 1 - suf]) suf += 1;
  const out = [];
  for (let k = 0; k < pre; k += 1) out.push({ t: 'ctx', s: aLines[k], oldNo: k + 1, newNo: k + 1 });
  const a = aLines.slice(pre, n - suf);
  const b = bLines.slice(pre, m - suf);
  const mid = myersDiff(a, b, 4000);
  if (mid) {
    for (const r of mid) {
      out.push({ t: r.t, s: r.s, oldNo: r.oi == null ? null : r.oi + pre + 1, newNo: r.ni == null ? null : r.ni + pre + 1 });
    }
  } else {
    a.forEach((s, k) => out.push({ t: 'del', s, oldNo: pre + k + 1, newNo: null }));
    b.forEach((s, k) => out.push({ t: 'add', s, oldNo: null, newNo: pre + k + 1 }));
  }
  for (let k = 0; k < suf; k += 1) {
    out.push({ t: 'ctx', s: aLines[n - suf + k], oldNo: n - suf + k + 1, newNo: m - suf + k + 1 });
  }
  return out;
}

function myersDiff(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((s, j) => ({ t: 'add', s, oi: null, ni: j }));
  if (m === 0) return a.map((s, i) => ({ t: 'del', s, oi: i, ni: null }));
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return null;
  const rows = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { x -= 1; y -= 1; rows.push({ t: 'ctx', s: a[x], oi: x, ni: y }); }
    if (d > 0) {
      if (x === px) { y -= 1; rows.push({ t: 'add', s: b[y], oi: null, ni: y }); }
      else { x -= 1; rows.push({ t: 'del', s: a[x], oi: x, ni: null }); }
    }
  }
  return rows.reverse();
}

function hunkifyDiff(lines, expanded = []) {
  const n = lines.length;
  if (!n) return [];
  const vis = new Array(n).fill(false);
  const isChange = (r) => r.t === 'add' || r.t === 'del';
  let any = false;
  for (let i = 0; i < n; i += 1) {
    if (!isChange(lines[i])) continue;
    any = true;
    const lo = Math.max(0, i - DIFF_CONTEXT);
    const hi = Math.min(n - 1, i + DIFF_CONTEXT);
    for (let k = lo; k <= hi; k += 1) vis[k] = true;
  }
  if (!any) {
    const hi = Math.min(n, DIFF_CONTEXT * 2);
    for (let k = 0; k < hi; k += 1) vis[k] = true;
  }
  for (const range of expanded) {
    const start = Math.max(0, Number(range[0]) || 0);
    const end = Math.min(n, Number(range[1]) || 0);
    for (let k = start; k < end; k += 1) vis[k] = true;
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (vis[i]) {
      out.push({ kind: 'line', i, row: lines[i] });
      i += 1;
    } else {
      let j = i;
      while (j < n && !vis[j]) j += 1;
      out.push({ kind: 'gap', start: i, end: j, count: j - i });
      i = j;
    }
  }
  return out;
}

function splitHljsLines(html) {
  const src = String(html ?? '');
  const lines = [];
  const stack = [];
  let buf = '';
  const re = /<\/?span\b[^>]*>|\n/gi;
  let last = 0;
  let m = re.exec(src);
  while (m) {
    buf += src.slice(last, m.index);
    const tag = m[0];
    if (tag === '\n') {
      buf += '</span>'.repeat(stack.length);
      lines.push(buf);
      buf = stack.join('');
    } else if (tag.startsWith('</')) {
      if (stack.length) stack.pop();
      buf += '</span>';
    } else {
      stack.push(tag);
      buf += tag;
    }
    last = m.index + tag.length;
    m = re.exec(src);
  }
  buf += src.slice(last);
  lines.push(buf);
  return lines;
}

async function highlightLines(path, text) {
  const n = String(text ?? '').split('\n').length;
  const lang = langFor(path);
  if (!lang) return Array.from({ length: n }, () => null);
  try {
    const hljs = await loadHljs();
    if (!hljs.getLanguage(lang)) return Array.from({ length: n }, () => null);
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    const lines = splitHljsLines(html);
    while (lines.length < n) lines.push('');
    if (lines.length > n) lines.length = n;
    return lines;
  } catch {
    return Array.from({ length: n }, () => null);
  }
}

async function highlightDiffRows(rows) {
  await Promise.all((rows || []).map(async (row) => {
    if (!row?.lines || row.skip) return;
    try {
      // Syntax-color only the head (new) file once, then slice per-line HTML
      // onto added and context rows. Removed lines stay plain escaped text.
      // Comment blocks are separate <tr>s and never enter this pass.
      const newHl = row.newText != null ? await highlightLines(row.path, row.newText) : [];
      for (const ln of row.lines) {
        if (ln.t === 'del') ln.html = null;
        else if ((ln.t === 'add' || ln.t === 'ctx') && ln.newNo) ln.html = newHl[ln.newNo - 1] || null;
        else ln.html = null;
      }
      row.highlighted = true;
    } catch {
      row.highlighted = false;
    }
  }));
}

function asNamedList(data, key) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data[key])) return data[key];
  return [];
}

function isGeneralComment(c) {
  return c == null || c.path == null || c.path === '';
}

function lineComments(comments, path, line, side) {
  return (comments || []).filter((c) => {
    if (isGeneralComment(c)) return false;
    if (String(c.path) !== String(path)) return false;
    if (Number(c.line) !== Number(line)) return false;
    return String(c.side || 'new').toLowerCase() === side;
  });
}

function meIsAuthor(d) {
  if (!getAuth()?.token || !d) return false;
  const id = getMe()?.user?.id;
  if (id != null && d.author_user_id != null && String(id) === String(d.author_user_id)) return true;
  const name = meName();
  return !!(name && (name === d.author || name === d.author_name || name === d.user || name === d.username));
}
function meIsPrAuthor(d) { return meIsAuthor(d); }

function commentIsMine(c) {
  const me = getMe()?.user;
  const name = meName();
  if (!me && !name) return false;
  if (me?.id != null) {
    const id = String(me.id);
    if (c.author_user_id != null && String(c.author_user_id) === id) return true;
    if (c.user_id != null && String(c.user_id) === id) return true;
    if (c.user != null && String(c.user) === id) return true;
  }
  return !!(name && (c.author === name || c.user === name || c.author_name === name));
}

function commentIsResolved(c) {
  return c?.resolved === true || c?.resolved === 1 || c?.resolved === 'true';
}

function commentCanResolve(c, pull) {
  if (!getAuth()?.token) return false;
  return commentIsMine(c) || meIsPrAuthor(pull);
}

function iApproved(approvals) {
  const name = meName();
  const id = getMe()?.user?.id;
  return (approvals || []).some((a) => a.user === name || a.user === id || a.user_id === id || a.author === name);
}

function ownerNames(owners) {
  return (owners || []).map((o) => o.user || o.user_name || o.name).filter(Boolean);
}

function approvalIsOwner(a, owners) {
  if (a?.owner === true) return true;
  if (a?.owner === false) return false;
  const name = a?.user || a?.author || a?.user_name;
  if (!name) return false;
  return ownerNames(owners).includes(name);
}

const CHECK_ICON = { success: '✓', failure: '✗', error: '!', cancelled: '–', running: '●', queued: '○' };
function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
}
function checksRollup(list, required) {
  const req = new Set(required || []);
  const counts = {};
  for (const c of list) counts[c.state] = (counts[c.state] || 0) + 1;
  const missing = [...req].filter((n) => !list.some((c) => c.name === n));
  const overall = list.some((c) => c.state === 'failure' || c.state === 'error') ? 'failure'
    : list.some((c) => c.state === 'running' || c.state === 'queued') || missing.length ? 'running'
    : list.length ? 'success' : 'none';
  return { counts, missing, overall };
}

function formatMergeReason(reason) {
  const s = String(reason || '');
  if (!s) return s;
  if (s === 'at least one owner approval is required' || /owner approval is required/i.test(s)) {
    return 'Needs approval from a repo owner';
  }
  if (/changes?_?requested/i.test(s)) return 'Changes requested by a reviewer';
  if (/draft/i.test(s)) return 'Draft pull request';
  return s;
}

async function loadPrFileBytes(org, repo, rev, path, pieceCid, size) {
  if (rev) {
    try {
      const blob = await loadBlob(org, repo, rev, path);
      if (blob?.bytes) return blob;
      if (blob && !pieceCid) return blob;
    } catch { /* try piece CID */ }
  }
  if (pieceCid) return bytesFromHint(org, repo, { pieceCid, size, length: size });
  return { bytes: null, loc: {}, spError: 'no storage URL' };
}

function textFromBytes(bytes, path) {
  if (!bytes) return { text: '', skip: 'empty' };
  if (!isLikelyText(bytes, path)) return { text: '', skip: 'binary file' };
  const slice = bytes.length > MAX_DIFF_BYTES ? bytes.subarray(0, MAX_DIFF_BYTES) : bytes;
  return { text: decodeUtf8(slice), skip: '', truncated: bytes.length > MAX_DIFF_BYTES };
}

async function loadCompare(org, repo, baseRev, headRev) {
  const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const tries = [
    `${b}/compare/${apiRef(baseRev)}...${apiRef(headRev)}`,
    `${b}/compare?base=${encodeURIComponent(baseRev)}&head=${encodeURIComponent(headRev)}`,
    `${b}/diff?base=${encodeURIComponent(baseRev)}&head=${encodeURIComponent(headRev)}`,
  ];
  for (const p of tries) {
    try {
      const data = await api(p);
      const files = data.files || data.changes || data.entries || [];
      if (Array.isArray(files) && (files.length || data.status === 'identical')) {
        return { source: 'compare', files: files.map((f) => ({
          path: f.path || f.filename || f.name,
          status: f.status || f.op || (f.kind === 'delete' ? 'removed' : 'modified'),
        })) };
      }
    } catch { /* try next / fall through */ }
  }
  const [baseCs, headCs] = await Promise.all([
    api(`${b}/changesets/${encodeURIComponent(baseRev)}`).catch(() => null),
    api(`${b}/changesets/${encodeURIComponent(headRev)}`).catch(() => null),
  ]);
  return { source: 'changesets', files: diffFilesFromMaps(pcidMap(baseCs), pcidMap(headCs)), baseCs, headCs };
}

async function loadPullFileList(org, repo, n, pr) {
  const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  try {
    const data = await api(`${b}/pulls/${encodeURIComponent(n)}/files`);
    const files = (data.files || data.changes || []).map((f) => ({
      path: f.path || f.filename || f.name,
      status: fileStatus(f),
      baseSize: f.baseSize ?? f.base_size,
      headSize: f.headSize ?? f.head_size,
      basePieceCid: f.basePieceCid || f.base_piece_cid,
      headPieceCid: f.headPieceCid || f.head_piece_cid,
    })).filter((f) => f.path);
    return { source: 'pr-files', files, base: data.base, head: data.head };
  } catch (e) {
    const baseRev = pr?.base_target || pr?.base_ref || pr?.base || 'main';
    const headRev = pr?.head_target || pr?.head_ref || pr?.head;
    if (!headRev) throw new Error(e.message || 'missing head target');
    const cmp = await loadCompare(org, repo, baseRev, headRev);
    return {
      ...cmp,
      base: baseRev,
      head: headRev,
      files: (cmp.files || []).map((f) => ({ ...f, path: f.path || f.filename || f.name, status: fileStatus(f) })),
    };
  }
}

async function loadFileDiffs(org, repo, baseRev, headRev, files) {
  const slice = files.slice(0, MAX_DIFF_FILES);
  const rows = [];
  for (const f of slice) {
    const path = f.path;
    if (!path) continue;
    const status = fileStatus(f);
    const row = { ...f, path, status, lines: null, skip: '', oldText: null, newText: null };
    try {
      const [oldB, newB] = await Promise.all([
        status === 'added' ? Promise.resolve(null) : loadPrFileBytes(org, repo, baseRev, path, f.basePieceCid, f.baseSize).catch(() => null),
        status === 'removed' ? Promise.resolve(null) : loadPrFileBytes(org, repo, headRev, path, f.headPieceCid, f.headSize).catch(() => null),
      ]);
      const oldParsed = oldB?.bytes ? textFromBytes(oldB.bytes, path) : { text: '', skip: oldB?.spError || (status === 'added' ? '' : 'missing base') };
      const newParsed = newB?.bytes ? textFromBytes(newB.bytes, path) : { text: '', skip: newB?.spError || (status === 'removed' ? '' : 'missing head') };
      if (oldParsed.skip === 'binary file' || newParsed.skip === 'binary file') {
        row.skip = 'binary file';
      } else if (!oldB?.bytes && !newB?.bytes) {
        row.skip = oldParsed.skip || newParsed.skip || 'could not fetch file bytes';
      } else {
        row.oldText = oldParsed.text;
        row.newText = newParsed.text;
        if (status === 'removed') row.lines = oldParsed.text.split('\n').map((s, i) => ({ t: 'del', s, oldNo: i + 1, newNo: null }));
        else if (status === 'added') row.lines = newParsed.text.split('\n').map((s, i) => ({ t: 'add', s, oldNo: null, newNo: i + 1 }));
        else row.lines = lcsDiffLines(oldParsed.text.split('\n'), newParsed.text.split('\n'));
        if (oldParsed.truncated || newParsed.truncated) row.skip = (row.skip ? `${row.skip}; ` : '') + 'preview truncated';
      }
    } catch (e) { row.skip = e.message || String(e); }
    rows.push(row);
  }
  return { rows, truncated: files.length > MAX_DIFF_FILES, total: files.length };
}

function isRefNotFoundMessage(msg) {
  return /ref\s+"[^"]+"\s+not found/i.test(String(msg || ''));
}
function friendlyFileError(err) {
  const msg = err?.message || String(err || '');
  if (isRefNotFoundMessage(msg)) return 'Could not load file.';
  return msg || 'Could not load file.';
}
function refAlias(ref) {
  const r = String(ref || 'main');
  if (r.startsWith('refs/heads/')) return r.slice('refs/heads/'.length) || 'main';
  if (r.startsWith('refs/tags/')) return r.slice('refs/tags/'.length);
  if (!r.startsWith('refs/')) return `refs/heads/${r}`;
  return '';
}
function refAttempts(ref) {
  const first = String(ref || 'main');
  const alt = refAlias(first);
  return [first, alt].filter((r, i, a) => r && a.indexOf(r) === i);
}
function entryPieceCid(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.pieceCid || entry.piece_cid || entry.pcid || '').trim();
}
function hintFromEntry(entry, path) {
  if (!entry) return null;
  const pieceCid = entryPieceCid(entry);
  const size = entrySize(entry);
  const hint = {
    path,
    pieceCid: pieceCid || undefined,
    size,
    length: size ?? entry.length,
    contentBase64: entry.contentBase64 || entry.content_base64,
    content: entry.content,
    url: entry.url,
    offset: entry.offset,
  };
  if (!hint.pieceCid && !inlineBytesFromLoc(hint) && !hint.url) return null;
  return hint;
}
async function findPathEntry(org, repo, ref, path, known) {
  const segs = String(path || '').split('/').filter(Boolean);
  const name = segs[segs.length - 1];
  const dir = segs.slice(0, -1).join('/');
  const fromList = (entries) => (entries || []).find((e) => e && e.name === name && kindOf(e) !== 'dir') || null;
  if (known && !Array.isArray(known) && known.name === name) return known;
  if (Array.isArray(known)) {
    const hit = fromList(known);
    if (hit) return hit;
  }
  for (const r of refAttempts(ref)) {
    try {
      const q = dir ? `?path=${encodeURIComponent(dir)}` : '';
      const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${apiRef(r)}${q}`);
      const hit = fromList(data.entries || []);
      if (hit) return hit;
    } catch { /* try the other ref form or snapshot */ }
  }
  return null;
}

async function loadBlob(org, repo, ref, path, opts = {}) {
  let lastErr = null;
  for (const r of refAttempts(ref)) {
    try {
      const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/blob/${apiRef(r)}?path=${encodeURIComponent(path)}`);
      const fetched = await bytesFromHint(org, repo, data);
      return { live: true, data, ...fetched };
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    const entry = await findPathEntry(org, repo, ref, path, opts.entry || opts.entries);
    const hint = hintFromEntry(entry, path);
    if (hint) {
      const fetched = await bytesFromHint(org, repo, hint);
      return { live: false, fallback: true, error: lastErr?.message, data: { path, ...hint, ...fetched.loc }, ...fetched };
    }
  } catch (e2) {
    if (!isRefNotFoundMessage(e2.message)) lastErr = e2;
  }
  try {
    const { cs } = await loadSnapshot(org, repo, ref);
    const pieceCid = cs?.metadata?.[`pcid:${path}`];
    const change = (cs?.changes || []).find((c) => c.path === path);
    if (pieceCid || change) {
      const hint = { pieceCid: pieceCid || change?.pieceCid, size: change?.size, path };
      const fetched = await bytesFromHint(org, repo, hint);
      return { live: false, fallback: true, error: lastErr?.message, data: { path, pieceCid: hint.pieceCid, ...fetched.loc }, ...fetched };
    }
  } catch { /* keep lastErr */ }
  if (lastErr) throw lastErr;
  throw new Error('Could not load file.');
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
function isMarkdownName(name) {
  return /\.md$/i.test(String(name || ''));
}
function parentDir(path) {
  return String(path || '').split('/').filter(Boolean).slice(0, -1).join('/');
}
function readmeCard(name, body, { loading = false } = {}) {
  return html`<div class="readme-wrap card">
    <div class="readme-head">${name || 'README'}</div>
    ${loading ? html`<p class="muted" style="padding:1rem 1.25rem">Loading…</p>` : body}
  </div>`;
}

function conflictSample() {
  return html`<pre class="conflict-sample"><code><span class="mark">&lt;&lt;&lt;&lt;&lt;&lt;&lt; local</span>
the line as it is on your branch
=======
the line as it is on main
<span class="mark">&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</span></code></pre>`;
}

function downloadSection() {
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  return html`
    <div class="download-grid">
      ${DOWNLOADS.map((d) => html`<article class="download-card ${(isMac ? d.mac : !d.mac) && (d.target !== 'x86_64-apple-darwin') ? 'recommended' : ''}">
        <h3>${d.label}</h3>
        <p class="muted">${d.note} · <code>scn-${d.target}.tar.gz</code> (<a href=${assetUrl(d.target) + '.sha256'} data-external>sha256</a>)</p>
        <a class="btn btn-primary" href=${assetUrl(d.target)} data-external>Download</a>
      </article>`)}
      <article class="download-card">
        <h3>From source (cargo)</h3>
        <p class="muted">Builds the <code>scn</code> CLI from the same tagged release.</p>
        ${pre([`cargo install --git https://github.com/scionhub/openscion --tag ${RELEASE_TAG} --bin scn`])}
      </article>
    </div>
    <p class="muted">All builds are on GitHub Release <a href=${RELEASE_PAGE} data-external target="_blank" rel="noopener">${RELEASE_TAG}</a>.</p>
    <div class="download-steps docs-content">
      <h3>Install on macOS</h3>
      ${pre([
        '# Apple Silicon; use x86_64-apple-darwin on Intel Macs',
        `curl -L -o scn.tar.gz ${assetUrl('aarch64-apple-darwin')}`,
        'tar xzf scn.tar.gz',
        'xattr -d com.apple.quarantine scn 2>/dev/null || true',
        'mkdir -p ~/.local/bin && mv scn ~/.local/bin/',
        'export PATH="$HOME/.local/bin:$PATH"',
        'scn --version',
      ])}
      <p class="tiny-note">The macOS binaries are not signed or notarized. If you download them with a browser, Gatekeeper blocks them ("cannot be opened because the developer cannot be verified"). Run <code>xattr -d com.apple.quarantine scn</code> once, or allow it under System Settings → Privacy &amp; Security. Downloads made with <code>curl</code> are usually not quarantined.</p>
      <h3>Install on Linux</h3>
      ${pre([
        `curl -L -o ${RELEASE_ASSET} ${RELEASE_ASSET_URL}`,
        `tar xzf ${RELEASE_ASSET}`,
        'mkdir -p ~/.local/bin',
        'mv scn ~/.local/bin/',
        'export PATH="$HOME/.local/bin:$PATH"',
        'scn --help',
      ])}
      <h3>Point it at ScionBase</h3>
      ${pre([ENV, 'scn version'])}
      <h3>Shell completion</h3>
      ${pre([
        'mkdir -p ~/.local/share/bash-completion/completions',
        'scn completion bash > ~/.local/share/bash-completion/completions/scn',
        'scn completion zsh > "${fpath[1]}/_scn"',
        'scn completion fish > ~/.config/fish/completions/scn.fish',
      ])}
    </div>`;
}

/* ---------- views ---------- */
const Home = () => html`
  <section class="hero"><div class="container hero-inner">
    <div class="hero-copy">
      <h1>Code hosting on Filecoin.<br />Verifiable by design.</h1>
      <p class="lede"><strong>ScionBase</strong> is git‑like code hosting where repository content lives on
        <strong>Filecoin</strong>. Storage providers prove they still hold every piece with <strong>PDP</strong>
        (Proof of Data Possession), each piece is addressed by its <strong>PieceCID</strong>, and files are
        read <strong>directly from the storage provider</strong>.</p>
      <p class="disclaimer">This is a <strong>proof of concept</strong>. Keep expectations realistic; we keep claims honest.</p>
      <p class="tiny-note">Part of <a href="/#/verified-products">Filecoin’s Verified Products</a>.</p>
      <div class="hero-cta">
        <a class="btn btn-primary btn-lg" href="/#start">Get started</a>
        <a class="btn btn-ghost btn-lg" href="/#/orgs">Browse orgs</a>
      </div>
    </div>
    <figure class="hero-art">
      <picture>
        <source type="image/webp" srcset="/assets/images/logo-512.webp" />
        <img class="hero-logo" src="/assets/images/logo-512.png" width="512" height="512" alt="ScionBase" />
      </picture>
      <figcaption class="hero-tagline">agent-scale collaboration on verified storage</figcaption>
    </figure>
  </div></section>

  <section id="problem" class="section"><div class="container">
    <h2>The problem we solve</h2>
    <div class="grid features">
      <article class="card"><h3>Code you can verify is still there</h3><p>Hosted code usually sits on one company's disks and you take availability on trust. On ScionBase, Filecoin storage providers continuously <strong>prove possession</strong> of your repo's data.</p></article>
      <article class="card"><h3>Content‑addressed</h3><p>Every stored piece has a <strong>PieceCID</strong>. The same bytes always have the same ID, so tampering is detectable.</p></article>
      <article class="card"><h3>Direct SP reads</h3><p>Browsing and cloning fetch bytes <strong>straight from the storage provider</strong> by PieceCID (PDP dataset ${DATASET}).</p></article>
      <article class="card"><h3>Git‑like workflow</h3><p>Orgs, repos, branches, pull requests, three‑way sync — at monorepo scale, for people and AI agents.</p></article>
    </div>
  </div></section>

  <section id="start" class="section alt"><div class="container docs-content">
    <h2>Get started</h2>
    <h3 id="download">1. Download the CLI</h3>
    <p>The CLI binary is <code>scn</code>. Prebuilt macOS (Apple Silicon, Intel) and Linux builds are on the <a href=${RELEASE_PAGE} data-external target="_blank" rel="noopener">${RELEASE_TAG} GitHub Release</a>. <a href="/#/cli">Full install page</a>.</p>
    ${downloadSection()}
    <h3 id="user">2. Create a user</h3>
    <p>On the web: <a href="/#/login">Sign in / create account</a>. Or with the CLI:</p>
    ${pre(['scn signup --username <you> --email <you@example.com>', 'scn login --user <you>'])}
    <h3 id="org">3. Your org and first repo</h3>
    <p>Your username is your org. Create more orgs on the <a href="/#/orgs">organizations</a> page or with the CLI.</p>
    ${pre(['scn org create <name>', 'scn org list', 'scn repo create <name>', 'scn repo create <name> --org <org>'])}
    <h3 id="import">4. Clone, branch, push</h3>
    ${pre(['scn clone <org>/<repo>', '# folder-only: scn clone <org>/<repo> --path <dir-or-file>', 'cd <repo>', 'scn branch new my-feature --from main', 'scn branch switch my-feature', '# edit files, then:', 'scn push -m "describe the change"', 'scn pr create --title "My change"'])}
    <p><a class="btn btn-primary" href="/#/getting-started">Full CLI guide: clone, branch, pull, merge, PR →</a></p>
  </div></section>

  <section id="pricing" class="section"><div class="container">
    <h2>Pricing</h2>
    <div class="pricing">
      <div class="price-card"><h3>Starter</h3><p class="price">$0</p><ul><li>First <strong>60 days</strong> or first <strong>500 MB</strong> — whichever comes first</li><li>Includes org + repos</li><li>Community support</li></ul></div>
      <div class="price-card highlight"><h3>Standard</h3><p class="price"><span class="price-number">$5</span><span class="price-unit">/ GB / year</span></p>
        <ul><li>Usage‑based, billed yearly</li><li>Minimum <strong>1 GB</strong></li><li>Payable in <strong>USD</strong> or <strong>ETH</strong></li></ul>
        <a class="btn btn-primary btn-lg" href="/checkout.html" data-external>Get started</a></div>
    </div>
    <p class="disclaimer center">Proof of concept: <strong>no real payment is taken</strong>. For pilots or production, contact <a href="https://filoz.org" target="_blank" rel="noopener">FilOz</a>.</p>
  </div></section>`;

/* ---------- verified products ---------- */
const VerifiedProducts = () => html`
  <div class="page"><div class="container docs-content">
    <h1>Filecoin Verified Products</h1>
    <p class="tiny-note">A small set of products that showcase Filecoin‑backed storage and access.</p>
    <div class="md-body">
      <table>
        <thead>
          <tr><th>Product</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><a href="https://fil.pub" target="_blank" rel="noopener">fil.pub</a></td>
            <td>Secrets share</td>
          </tr>
          <tr>
            <td><a href="https://curiostorage.github.io/filstream" target="_blank" rel="noopener">FilStream</a></td>
            <td>Video sharing</td>
          </tr>
          <tr>
            <td><a href="https://pin.filecoin.cloud/" target="_blank" rel="noopener">pin.filecoin.cloud</a></td>
            <td>Store your files with IPFS reachability</td>
          </tr>
          <tr>
            <td><a href="https://scionbase.ai" target="_blank" rel="noopener">ScionBase</a></td>
            <td>PoC source hosting on Filecoin</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div></div>`;

const CI_YML_EXAMPLE = `# .scionbase/ci.yml
jobs:
  vet:
    runs-on: [linux, x64]      # runner must have every label
    timeout: 300               # seconds for the whole job (default 600, max 3600)
    steps:
      - name: toolchain
        run: go version
      - name: go vet
        run: go vet ./lib/promise/...
  unit:
    runs-on: linux
    steps:
      - name: tests
        run: |
          make deps
          go test ./...`;

const CiDocs = () => html`
  <div class="page"><div class="container docs-content">
    <h1>CI on ScionBase</h1>
    <p>ScionBase runs CI on <strong>your own machines</strong> and shows the results on pull requests. There is no GitHub mirror and no hosted build farm: a small runner (<code>scn runner</code>) connects <em>outbound</em> over HTTPS, so it works behind a firewall or NAT with no open ports.</p>
    <h2 id="how">How it works</h2>
    <ol>
      <li>When a pull request is opened or its branch is pushed, and on every push to <code>main</code>, ScionBase reads <code>.scionbase/ci.yml</code> <em>at that exact changeset</em> and queues one check per job.</li>
      <li>A runner registered on the repo long-polls for queued jobs whose <code>runs-on</code> labels it has, clones that changeset with <code>scn clone --at</code>, runs each step with <code>bash -eo pipefail</code> in a fresh temp directory, streams the log back every few seconds, posts the final state, deletes the checkout, and polls again.</li>
      <li>The PR page shows every check with its state, duration and log. Owners can re-run a job. Under <em>Settings → Required checks</em>, owners list job names that must be <code>success</code> on the PR head before it can merge.</li>
    </ol>
    <h2 id="yml">1. Add <code>.scionbase/ci.yml</code></h2>
    <p>The format is deliberately small: <code>jobs: { name: { runs-on: [labels], steps: [ {name, run} ], timeout } }</code>. Job names use <code>[A-Za-z0-9_.-]</code>. Steps run in the repository root. The environment includes <code>CI=true</code>, <code>SCN_JOB</code>, <code>SCN_CHANGESET</code> and <code>SCN_REPO</code>.</p>
    ${pre(CI_YML_EXAMPLE)}
    <h2 id="runner">2. Register and start a runner</h2>
    <p>As a repo owner, register a runner (or use <em>Settings → Runners</em> on the web). This saves a runner token to <code>~/.config/scn/runners/&lt;org&gt;__&lt;repo&gt;.json</code> with mode 600. The token can only claim and report jobs for that one repo.</p>
    ${pre(['scn login --user <you>', 'scn runner register --repo <org>/<repo> --labels linux,x64', 'scn runner run --repo <org>/<repo>            # loops forever', 'scn runner run --repo <org>/<repo> --once     # one job, then exit', 'scn runner list --repo <org>/<repo>', 'scn runner remove <name> --repo <org>/<repo>'])}
    <p class="tiny-note">Steps run as the user that runs <code>scn runner</code>, so use a dedicated account or a VM/container for untrusted pull requests. The runner strips <code>SCN_TOKEN</code>, <code>SCN_RUNNER_TOKEN</code> and <code>SCN_PASSWORD</code> from the step environment. To keep it running, use systemd, launchd or <code>tmux</code>.</p>
    <h2 id="report">3. Report results from any script</h2>
    <p>Already have a CI system, such as a GitHub Actions job, Jenkins or a cron script? Push its results into ScionBase with <code>scn ci report</code>. It needs a repo owner's login, <code>SCN_TOKEN</code>, or a runner token in <code>SCN_RUNNER_TOKEN</code>.</p>
    ${pre(['scn ci report lint --pr 3 --state success --summary "0 warnings"', 'scn ci report e2e --changeset <64-hex> --state failure --log e2e.log --url https://ci.example.com/run/42', 'scn ci report nightly --ref main --state success'])}
    <p>States: <code>queued</code>, <code>running</code>, <code>success</code>, <code>failure</code>, <code>error</code>, <code>cancelled</code>. Only the last 1 MB of a log is kept.</p>
    <h2 id="inspect">4. Inspect and re-run</h2>
    ${pre(['scn ci list --pr 3', 'scn ci log vet --pr 3', 'scn ci rerun vet --pr 3          # owners; ci.yml jobs only'])}
    <h2 id="completion">Shell completion</h2>
    <p><code>scn completion bash|zsh|fish</code> includes <code>ci</code> and <code>runner</code> and their flags.</p>
    <h2 id="webhooks">Webhooks</h2>
    <p>Integrate external systems with <strong>Webhooks</strong>. Configure them under <em>Repository → Settings → Webhooks</em>; choose events such as pushes, pull requests, issues or checks.</p>
    <h2 id="api">HTTP API</h2>
    ${pre(['GET  /v1/repos/{org}/{repo}/checks?pr=N | ?changeset=X | ?ref=main', 'POST /v1/repos/{org}/{repo}/checks            {name, state, pr|changeset|ref, summary, log, target_url}', 'GET  /v1/repos/{org}/{repo}/checks/{id}/log', 'POST /v1/repos/{org}/{repo}/checks/rerun      {name, pr|changeset}', 'GET|POST /v1/repos/{org}/{repo}/runners       (owners)', 'DELETE   /v1/repos/{org}/{repo}/runners/{name}', 'POST /v1/runners/poll                          (runner token, long-poll)', 'PATCH /v1/runners/jobs/{id}                    {state, log_append, summary}'])}
  </div></div>`;

const GettingStarted = () => html`
  <div class="page"><div class="container docs-content">
    <h1>CLI guide</h1>
    <p class="tiny-note">The ScionBase CLI is <code>scn</code>. <a href="/#/cli">Download</a>.</p>
    <h2 id="setup">1. Check the CLI</h2>
    ${pre(['scn version'])}
    <h2 id="account">2. Create an account and log in</h2>
    <p>Needed for writes. Username must match <code>^[a-z0-9][a-z0-9-]{2,31}$</code>; password at least 10 characters. Or use the <a href="/#/login">web sign in</a>.</p>
    ${pre(['scn signup --username <you>', 'scn signup --username <you> --email <you@example.com>', 'scn login --user <you>'])}
    <h2 id="create">3. Organizations and repositories</h2>
    <p>Creates a public repo under your username org or an org you belong to. <code>filecoin-project</code> is admin-only. Non-admins: 3 repos max. Name: <code>^[a-z0-9][a-z0-9._-]{0,63}$</code>. On the web: <a href="/#/new">New repository</a>, <a href="/#/orgs">New organization</a>.</p>
    ${pre(['scn org create <name>', 'scn org list', 'scn repo create <name>', 'scn repo create <name> --org <org>'])}
    <h2 id="clone">4. Clone</h2>
    <p>Public clones need no account. Git-like: <code>scn clone org/repo [dir] [--branch b]</code>.</p>
    ${pre(['scn clone filecoin-project/curio', 'scn clone filecoin-project/curio ./curio --branch main'])}
    <p><strong>Folder-only checkout</strong>: use <code>--path</code> to materialize just a directory or file (sparse clone). Example:</p>
    ${pre(['scn clone filecoin-project/lotus --path src'])}
    <p class="tiny-note"><strong>Exclude a folder</strong>: full-tree clone has no per-folder exclude yet — use <code>--path</code> to check out only what you need.</p>
    <h2 id="branch">5. Branch</h2>
    ${pre(['scn branch', 'scn branch new my-feature --from main', 'scn branch switch my-feature', 'scn branch delete old-feature'])}
    <h2 id="pull">6. Pull, merge, push</h2>
    <p><code>scn pull</code> fetches the current branch. <code>scn merge &lt;ref&gt;</code> three‑way merges; both‑changed paths get git‑style markers. To publish changes, run <code>scn commit -m "…"</code> then <code>scn push</code> — or after edits use <code>scn push -m "…"</code> to commit+publish in one step.</p>
    ${pre(['scn pull', 'scn merge main', '# edit files', 'scn commit -m "describe the change"', 'scn push', '# or:', 'scn push -m "describe the change"'])}
    ${conflictSample()}
    <p>Edit the file to the resolved contents (remove the markers), then push.</p>
    <h2 id="pr">7. Pull requests</h2>
    <p>Merge is org member/admin; close is the author or an admin. Fast-forward when the head changeset’s first parent is still the current base.</p>
    ${pre(['scn pr create --title "My change"', 'scn pr create --title "My change" --body "details"', 'scn pr list', 'scn pr show 1', 'scn pr merge 1', 'scn pr close 1'])}
    <p class="tiny-note">On the web: create a pull request (including <strong>draft</strong>), <strong>approve</strong> or <strong>request changes</strong>, and choose <strong>Fast‑forward</strong> or <strong>Squash</strong> when merging.</p>
    <p class="tiny-note"><strong>Fixes</strong>: add issue numbers (e.g. <code>12, 15</code>) to a PR to close those issues automatically when it merges. <strong>Issues</strong> can include a short <em>tag</em> on create/edit and the Issues list supports filtering by <code>?tag=</code>. Title and description are editable only by the issue author; anyone signed in can comment. Use <strong>Boards</strong> (owned by an organization, at <a href="/#/boards">/#/boards</a> or <code>/#/orgs/:org/boards</code>) to save a tag/state filter and see matching issues at a glance — including issues from other orgs.</p>
    <h2 id="completion">8. Completion</h2>
    ${pre(['scn completion bash', 'scn completion zsh', 'scn completion fish'])}
    <p>Browse <a href="/#/orgs">organizations</a>.</p>
  </div></div>`;

const CliView = () => html`
  <div class="page"><div class="container docs-content">
    <h1>Download the CLI</h1>
    <p>The ScionBase CLI is <code>scn</code>. Linux x86_64 builds are published on GitHub Release
      <a href=${RELEASE_PAGE} data-external target="_blank" rel="noopener">${RELEASE_TAG}</a>.</p>
    ${downloadSection()}
    <p><a href="/#/getting-started">Full CLI guide</a></p>
  </div></div>`;

const LoginView = () => {
  const st = { loginErr: '', signupErr: '', loginBusy: false, signupBusy: false };
  const view = () => html`
    <div class="page"><div class="container">
      <h1>Sign in</h1>
      <p class="tiny-note">Accounts are stored on ScionBase. Username <code>^[a-z0-9][a-z0-9-]{2,31}$</code>, password at least 10 characters.</p>
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
  const st = { owners: auth?.username ? [{ id: auth.username, role: 'you' }] : [], err: '', busy: false, created: null };
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
        ${pre([ENV, `scn clone ${full}`, `cd ${c.name}`, `scn push -m "initial import"`])}
      </div></div>`;
    }
    return html`<div class="page"><div class="container narrow">
      <h1>New repository</h1>
      <p class="tiny-note">Creates a public repo via <code>POST /v1/repos</code>. Non-admins: 3 repos max. <code>filecoin-project</code> is admin-only.</p>
      <form class="card form" @submit=${onCreate}>
        <label for="repo-owner">Owner</label>
        <select id="repo-owner" name="org">${st.owners.map((o) => html`<option value=${o.id} ?selected=${o.id === auth.username}>${o.role && o.role !== 'you' ? `${o.id} (${o.role})` : o.id}</option>`)}</select>
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
      if (auth?.token) await refreshMe();
      const owners = ownerChoices();
      st.owners = owners.length ? owners : (auth?.username ? [{ id: auth.username, role: 'you' }] : []);
      rerender();
    },
  };
};

const OrgView = (org) => {
  const st = { s: null };
  const view = (s) => html`
    <div class="page-head"><div class="container"><div class="subnav">
            ${getAuth() ? html`<a class="btn btn-primary" href="/#/new">New repository</a>` : nothing}
            <a class="btn" href=${boardsUrl(org)}>Boards</a>
    </div></div></div>
    <div class="page"><div class="container layout-2col">
      <aside class="sidebar"><div class="card">
        <div style="display:flex;align-items:center;gap:.75rem;"><div class="org-avatar" aria-hidden="true">${org.slice(0, 2).toUpperCase()}</div>
          <div><h2 style="margin:0">${org}</h2><div class="tiny-note">@${org}</div></div></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:.9rem 0;" />
        <p class="tiny-note">Repo content stored on Filecoin (PDP dataset ${DATASET}). POC.</p>
      </div></aside>
      <section class="content">
        <h3 style="margin-bottom:.5rem;">Repositories</h3>
        <ul class="repo-list">${!s ? html`<li class="repo-item"><span class="muted">Loading…</span></li>`
          : s.data.length ? s.data.map((r) => html`<li class="repo-item"><a href=${repoUrl(org, r)}><strong>${org}/${r}</strong></a><span class="badge">public</span></li>`)
          : html`<li class="repo-item"><span class="muted">No repositories yet.</span></li>`}</ul>
        <p class="tiny-note">Have code to bring? <a href="/#/getting-started">Clone and push with <code>scn</code></a>. Organization boards: <a href=${boardsUrl(org)}>view boards</a>.</p>
      </section>
    </div></div>`;
  return { view: () => view(st.s), load: async (rerender) => {
    st.s = await tryGet(`/v1/orgs/${encodeURIComponent(org)}/repos`, FALLBACK.repos[org] || []);
    if (st.s.live && !Array.isArray(st.s.data)) st.s.data = st.s.data.repos || [];
    st.s.data = st.s.data.map((r) => (typeof r === 'string' ? r : r.name));
    rerender();
  } };
};

/* ---------- user home / settings ---------- */
const UserView = (name) => {
  const isSelf = () => {
    const me = (meName() || '').toLowerCase();
    return !!me && me === String(name || '').toLowerCase();
  };
  const st = {
    profile: null,
    repos: null,
    reposErr: '',
    tagline: '',
    taglineBusy: false,
    taglineErr: '',
    taglineOk: '',
    pwBusy: false,
    pwErr: '',
    pwOk: '',
  };

  async function onChangePassword(e) {
    e.preventDefault();
    if (st.pwBusy) return;
    const fd = new FormData(e.target);
    const currentPassword = String(fd.get('current_password') || '');
    const newPassword = String(fd.get('new_password') || '');
    st.pwErr = ''; st.pwOk = ''; st.pwBusy = true; draw();
    try {
      if (newPassword.length < 10) throw new Error('new password must be at least 10 characters');
      if (currentPassword === newPassword) throw new Error('new password must be different from the current password');
      await changeMyPassword({ currentPassword, newPassword });
      st.pwOk = 'Password updated.';
      e.target.reset();
    } catch (err) {
      st.pwErr = err.message || String(err);
    }
    st.pwBusy = false;
    draw();
  }

  async function onSaveTagline(e) {
    e.preventDefault();
    if (st.taglineBusy) return;
    const tagline = String(st.tagline || '').slice(0, TAGLINE_MAX);
    st.taglineErr = ''; st.taglineOk = ''; st.taglineBusy = true; draw();
    try {
      const data = await patchMyProfile({ tagline });
      st.tagline = extractTagline(data) || tagline;
      if (st.profile?.data) {
        const dest = st.profile.data.user && typeof st.profile.data.user === 'object'
          ? st.profile.data.user
          : st.profile.data;
        dest.tagline = st.tagline;
      }
      st.taglineOk = 'Profile saved.';
    } catch (err) {
      st.taglineErr = err.message || String(err);
    }
    st.taglineBusy = false;
    draw();
  }

  const comingSoon = (title) => html`<section class="card coming-soon" aria-disabled="true">
    <h3 style="margin-top:0">${title}</h3>
    <p class="muted" style="margin:0">Coming soon</p>
  </section>`;

  return {
    view: () => {
      const self = isSelf();
      const publicTagline = extractTagline(st.profile?.live ? st.profile.data : null);
      const repos = st.repos;
      return html`<div class="page-head"><div class="container"><div class="subnav">
        ${self && getAuth() ? html`<a class="btn btn-primary" href="/#/new">New repository</a>` : nothing}
      </div></div></div>
      <div class="page"><div class="container layout-2col">
        <aside class="sidebar"><div class="card">
          <div style="display:flex;align-items:center;gap:.75rem;">
            <div class="org-avatar" aria-hidden="true">${String(name).slice(0, 2).toUpperCase()}</div>
            <div>
              <h2 style="margin:0">${name}</h2>
              <div class="tiny-note">@${name}${self ? ' · you' : ''}</div>
            </div>
          </div>
          ${self ? nothing
            : st.profile?.live && String(publicTagline).trim()
              ? html`<p class="user-tagline">${publicTagline}</p>`
              : st.profile?.live
                ? html`<p class="muted" style="margin:.9rem 0 0">No tagline.</p>`
                : nothing}
        </div></aside>
        <section class="content">
          <h3 style="margin-bottom:.5rem;">Repositories</h3>
          <ul class="repo-list">${!repos ? html`<li class="repo-item"><span class="muted">${st.reposErr || 'Loading…'}</span></li>`
            : repos.length ? repos.map((r) => html`<li class="repo-item"><a href=${repoUrl(r.org, r.name)}><strong>${r.org}/${r.name}</strong></a><span class="badge">public</span></li>`)
            : html`<li class="repo-item"><span class="muted">${st.reposErr || 'No public repositories.'}</span></li>`}</ul>
          ${self ? html`<div class="user-settings">
            <h2>Settings</h2>
            <form class="card form" @submit=${onChangePassword}>
              <h3 style="margin-top:0">Change password</h3>
              <label for="pw-current">Current password</label>
              <input id="pw-current" name="current_password" type="password" autocomplete="current-password" required minlength="10" />
              <label for="pw-new">New password</label>
              <input id="pw-new" name="new_password" type="password" autocomplete="new-password" required minlength="10" />
              <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.pwBusy}>${st.pwBusy ? 'Updating…' : 'Update password'}</button></div>
              ${st.pwErr ? html`<p class="form-error">${st.pwErr}</p>` : nothing}
              ${st.pwOk ? html`<p class="form-ok">${st.pwOk}</p>` : nothing}
            </form>
            ${comingSoon('Billing')}
            ${comingSoon('Notifications')}
            <form class="card form" @submit=${onSaveTagline}>
              <h3 style="margin-top:0">Profile</h3>
              <label for="me-tagline">Tagline</label>
              <textarea id="me-tagline" rows="3" maxlength=${String(TAGLINE_MAX)} .value=${st.tagline}
                @input=${(e) => {
                  st.tagline = String(e.target.value || '').slice(0, TAGLINE_MAX);
                  const el = document.getElementById('tagline-count');
                  if (el) el.textContent = `${st.tagline.length} / ${TAGLINE_MAX}`;
                }}></textarea>
              <p id="tagline-count" class="char-count">${(st.tagline || '').length} / ${TAGLINE_MAX}</p>
              <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.taglineBusy}>${st.taglineBusy ? 'Saving…' : 'Save profile'}</button></div>
              ${st.taglineErr ? html`<p class="form-error">${st.taglineErr}</p>` : nothing}
              ${st.taglineOk ? html`<p class="form-ok">${st.taglineOk}</p>` : nothing}
            </form>
          </div>` : nothing}
        </section>
      </div></div>`;
    },
    load: async (rerender) => {
      const self = isSelf();
      if (self && getAuth()?.token && !getMe()) await refreshMe();
      const profile = await tryGet(`/v1/users/${encodeURIComponent(name)}`, null, { auth: !!getAuth()?.token });
      st.profile = profile;
      if (self) {
        st.tagline = extractTagline(profile?.live ? profile.data : null) || extractTagline(getMe()) || '';
      }

      const seen = new Set();
      const repos = [];
      const addAll = (list) => {
        for (const r of list || []) {
          const key = `${r.org}/${r.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          repos.push(r);
        }
      };
      if (profile?.live) addAll(collectRepos(profile.data, name));
      if (self) addAll(collectRepos(getMe()?.ownedRepos || getMe()?.owned_repos, name));
      const orgRepos = await tryGet(`/v1/orgs/${encodeURIComponent(name)}/repos`, []);
      if (orgRepos.live) {
        let list = orgRepos.data;
        if (!Array.isArray(list)) list = list?.repos || [];
        addAll(collectRepos(list, name));
      } else if (!repos.length && orgRepos.status && orgRepos.status !== 404) {
        st.reposErr = orgRepos.error || 'Could not load repositories.';
      }
      st.repos = repos;
      rerender();
    },
  };
};

/* ---------- Boards (org-owned; issues may be cross-org) ---------- */
function boardKey(b) {
  return b?.id || b?.number || b?.name || '';
}
function boardsFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.boards)) return data.boards;
  return [];
}
function unwrapBoardGet(data) {
  const nested = data?.board && typeof data.board === 'object' ? data.board : null;
  const board = nested ? { ...data, ...nested } : (data && typeof data === 'object' ? data : {});
  const issues = Array.isArray(data?.issues) ? data.issues : (Array.isArray(data) ? data : []);
  return { board, issues };
}
function apiUnavailable(result) {
  return !!(result && result.live === false && (result.status === 404 || result.status === 405));
}
function formatBoardSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  return sources.map((s) => {
    if (typeof s === 'string') return s;
    const o = s?.org || s?.owner || '';
    const r = s?.repo || s?.name || '';
    if (!o) return r || '';
    return r ? `${o}/${r}` : o;
  }).filter(Boolean).join(', ');
}
function boardCreateBody(st) {
  const name = String(st.name || '').trim();
  if (!name) throw new Error('name is required');
  const body = { name };
  const tag = String(st.tag || '').trim();
  const state = String(st.state || '').trim();
  if (tag) body.tag = tag;
  if (state) body.state = state;
  const sources = (st.sources || []).map((s) => {
    const o = String(s.org || '').trim();
    const r = String(s.repo || '').trim();
    if (!o) return null;
    return r ? { org: o, repo: r } : { org: o };
  }).filter(Boolean);
  if (sources.length) body.sources = sources;
  return body;
}
function boardMetaNote(board, ownerOrg) {
  const org = board.org || ownerOrg || '';
  const src = formatBoardSources(board.sources);
  const bits = [];
  if (org) bits.push(html`Owned by <a href=${orgUrl(org)}>${org}</a>`);
  if (board.tag) bits.push(html`tag: <strong>${board.tag}</strong>`);
  if (board.state) bits.push(html`state: ${board.state}`);
  bits.push(src ? html`sources: ${src}` : html`sources: any org`);
  return html`<p class="tiny-note">${bits.map((b, i) => html`${i ? ' · ' : nothing}${b}`)}</p>`;
}
function boardIssueRow(i, fallbackOrg) {
  const o = i.org || i.owner || fallbackOrg || '';
  const r = i.repo || i.repository || '';
  const n = i.number ?? i.id;
  const label = o && r ? `${o}/${r}#${n}` : (o ? `${o}#${n}` : `#${n}`);
  const href = o && r && n != null ? repoUrl(o, r, ['issues', String(n)]) : '';
  return html`<li class="repo-item">
    ${href
      ? html`<a href=${href}><strong>${label}</strong> ${i.title || ''}</a>`
      : html`<strong>${label}</strong> ${i.title || ''}`}
    <span class="badge">${i.state || 'open'}</span>
    ${i.tag ? html`<span class="tiny-note" style="margin-left:.25rem">tag: <strong>${i.tag}</strong></span>` : nothing}
  </li>`;
}
function boardSourceFields(st) {
  return html`
    <p class="tiny-note">Optional source filters (org + optional repo). Leave empty to include issues from any organization the API returns.</p>
    ${(st.sources || []).map((s, i) => html`<div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap;margin:.35rem 0">
      <label style="flex:1;min-width:8rem">Org
        <input type="text" .value=${s.org} @input=${(e) => { s.org = e.target.value; }} placeholder="any-org" />
      </label>
      <label style="flex:1;min-width:8rem">Repo <span class="tiny-note">optional</span>
        <input type="text" .value=${s.repo} @input=${(e) => { s.repo = e.target.value; }} placeholder="any repo" />
      </label>
      <button class="btn" type="button" @click=${() => { st.sources.splice(i, 1); draw(); }}>Remove</button>
    </div>`)}
    <button class="btn" type="button" @click=${() => { st.sources.push({ org: '', repo: '' }); draw(); }}>Add source</button>
  `;
}
function boardCreateFields(st, { nameId }) {
  return html`
    <label for=${nameId}>Name</label>
    <input id=${nameId} type="text" .value=${st.name} @input=${(e) => { st.name = e.target.value; }} required />
    <label for="${nameId}-tag">Tag <span class="tiny-note">optional</span></label>
    <input id="${nameId}-tag" type="text" placeholder="ui, infra, urgent" .value=${st.tag} @input=${(e) => { st.tag = e.target.value; }} />
    <label for="${nameId}-state">State <span class="tiny-note">optional</span></label>
    <select id="${nameId}-state" .value=${st.state} @change=${(e) => { st.state = e.target.value; }}>
      <option value="" ?selected=${!st.state}>—</option>
      ${['open', 'closed', 'all'].map((s) => html`<option value=${s} ?selected=${st.state === s}>${s}</option>`)}
    </select>
    ${boardSourceFields(st)}
  `;
}
async function loadVisibleOrgNames() {
  const names = [];
  const seen = new Set();
  const add = (id) => {
    const n = String(id || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    names.push(n);
  };
  const fromList = (list) => {
    for (const o of list || []) add(typeof o === 'string' ? o : o?.id || o?.name);
  };
  if (getAuth()?.token) {
    let me = getMe();
    if (!me) me = await refreshMe();
    add(meName() || getAuth()?.username);
    fromList(me?.orgs);
  }
  try {
    const d = await api('/v1/orgs');
    fromList(Array.isArray(d) ? d : d?.orgs || []);
  } catch { /* keep username/me orgs */ }
  return names;
}
async function fetchOrgBoards(org) {
  return tryGet(`/v1/orgs/${encodeURIComponent(org)}/boards`, { boards: [] }, { auth: !!getAuth()?.token });
}

const OrgBoardsView = (org) => {
  const st = { boards: null, err: '', formErr: '', busy: false, name: '', tag: '', state: '', sources: [] };
  async function onCreate(e) {
    e.preventDefault();
    if (st.busy) return;
    st.formErr = ''; st.busy = true; draw();
    try {
      const body = boardCreateBody(st);
      const data = await api(`/v1/orgs/${encodeURIComponent(org)}/boards`, { method: 'POST', auth: true, body });
      const id = boardKey(data) || data?.board && boardKey(data.board);
      if (!id) throw new Error('board create did not return an id');
      navigate(boardUrl(org, id));
    } catch (err) { st.formErr = err.message || String(err); st.busy = false; draw(); }
  }
  return {
    view: () => {
      const list = boardsFrom(st.boards?.data);
      return html`<div class="page"><div class="container">
        <p class="tiny-note"><a href="/#/boards">All boards</a> · <a href=${orgUrl(org)}>${org}</a></p>
        <h1>Boards · ${org}</h1>
        <p class="tiny-note">This organization owns the board. Matching issues may come from any org.</p>
        ${getAuth() ? html`<form class="card form" style="max-width:34rem;margin:0 0 1.25rem" @submit=${onCreate}>
          <h2 style="margin-top:0">New board</h2>
          <p class="tiny-note">Owner: <strong>${org}</strong></p>
          ${boardCreateFields(st, { nameId: 'obd-name' })}
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>${st.busy ? 'Creating…' : 'Create board'}</button></div>
          ${st.formErr ? html`<p class="form-error">${st.formErr}</p>` : nothing}
        </form>` : html`<p class="tiny-note"><a href="/#/login">Sign in</a> to create a board.</p>`}
        ${!st.boards ? html`<p class="muted">${st.err || 'Loading boards…'}</p>`
          : apiUnavailable(st.boards) ? html`<p class="muted">Boards are not available on this API yet.</p>`
          : list.length
            ? html`<ul class="repo-list">${list.map((b) => {
                const id = boardKey(b);
                const owner = b.org || org;
                return html`<li class="repo-item">
                  <a href=${boardUrl(owner, id)}><strong>${b.name || id}</strong></a>
                  <span class="tiny-note">${owner}${b.tag ? ` · tag: ${b.tag}` : ''}${b.state ? ` · ${b.state}` : ''}</span>
                </li>`;
              })}</ul>`
            : html`<p class="muted">No boards yet.</p>`}
      </div></div>`;
    },
    load: async (rerender) => {
      try {
        st.boards = await fetchOrgBoards(org);
      } catch {
        st.boards = { live: false, status: 404, data: { boards: [] } };
      }
      rerender();
    },
  };
};

const BoardView = (org, id) => {
  const st = { s: null, err: '', delBusy: false, delErr: '' };
  async function onDelete() {
    if (st.delBusy) return;
    if (!confirm('Delete this board?')) return;
    st.delErr = ''; st.delBusy = true; draw();
    try {
      await api(`/v1/orgs/${encodeURIComponent(org)}/boards/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true });
      navigate(boardsUrl(org));
    } catch (e) {
      st.delErr = e.message || String(e);
      st.delBusy = false; draw();
    }
  }
  return {
    view: () => {
      const raw = st.s?.data;
      const { board, issues } = unwrapBoardGet(Array.isArray(raw) ? { issues: raw } : raw);
      const owner = board.org || org;
      const head = board.name || `Board ${id}`;
      return html`<div class="page"><div class="container">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
          <h1 style="margin:.2rem 0">${head}</h1>
          <div>
            <a class="btn" href=${boardsUrl(owner)}>Org boards</a>
            <a class="btn" href="/#/boards">All boards</a>
            <button class="btn" type="button" ?disabled=${st.delBusy} @click=${onDelete}>${st.delBusy ? 'Deleting…' : 'Delete board'}</button>
          </div>
        </div>
        ${boardMetaNote(board, owner)}
        ${!st.s ? html`<p class="muted">${st.err || 'Loading board…'}</p>`
          : apiUnavailable(st.s) ? html`<p class="muted">Boards are not available on this API yet.</p>`
          : issues.length ? html`<ul class="repo-list">${issues.map((i) => boardIssueRow(i, owner))}</ul>`
            : html`<p class="muted">No matching issues.</p>`}
        ${st.delErr ? html`<p class="form-error">${st.delErr}</p>` : nothing}
      </div></div>`;
    },
    load: async (rerender) => {
      try {
        st.s = await tryGet(
          `/v1/orgs/${encodeURIComponent(org)}/boards/${encodeURIComponent(id)}`,
          { issues: [] },
          { auth: !!getAuth()?.token },
        );
      } catch (e) { st.err = e.message || String(e); st.s = null; }
      rerender();
    },
  };
};

const BoardsView = () => {
  const st = { groups: null, err: '', formErr: '', busy: false, orgs: [], orgSel: '', name: '', tag: '', state: '', sources: [] };
  async function onCreate(e) {
    e.preventDefault();
    if (st.busy) return;
    st.formErr = ''; st.busy = true; draw();
    try {
      const org = String(st.orgSel || '').trim();
      if (!org) throw new Error('select an owner organization');
      const body = boardCreateBody(st);
      const data = await api(`/v1/orgs/${encodeURIComponent(org)}/boards`, { method: 'POST', auth: true, body });
      const id = boardKey(data) || data?.board && boardKey(data.board);
      if (!id) throw new Error('board create did not return an id');
      navigate(boardUrl(org, id));
    } catch (err) { st.formErr = err.message || String(err); st.busy = false; draw(); }
  }
  return {
    view: () => {
      const groups = st.groups || [];
      const missing = groups.length ? groups.every((g) => apiUnavailable(g.result)) : false;
      const rows = [];
      for (const g of groups) {
        if (apiUnavailable(g.result)) continue;
        for (const b of boardsFrom(g.result.data)) rows.push({ org: b.org || g.org, board: b });
      }
      const ownerOrgs = ownerChoices().map((o) => o.id);
      const orgOpts = ownerOrgs.length ? ownerOrgs : st.orgs;
      return html`<div class="page"><div class="container">
        <h1>Boards</h1>
        <p class="tiny-note">Boards are owned by an organization. Pick an org you belong to to create one; a board can still list issues from any org.</p>
        ${getAuth() ? html`<form class="card form" style="max-width:34rem;margin:0 0 1.25rem" @submit=${onCreate}>
          <h2 style="margin-top:0">New board</h2>
          <label for="bd-org">Owner organization</label>
          <select id="bd-org" .value=${st.orgSel} @change=${(e) => { st.orgSel = e.target.value; }}>
            <option value="">—</option>
            ${orgOpts.map((o) => html`<option value=${o} ?selected=${o === st.orgSel}>${o}</option>`)}
          </select>
          ${st.orgSel ? html`<p class="tiny-note">Or open <a href=${boardsUrl(st.orgSel)}>${st.orgSel} boards</a>.</p>` : nothing}
          ${boardCreateFields(st, { nameId: 'bd-name' })}
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>${st.busy ? 'Creating…' : 'Create board'}</button></div>
          ${st.formErr ? html`<p class="form-error">${st.formErr}</p>` : nothing}
        </form>` : html`<p class="tiny-note"><a href="/#/login">Sign in</a> to create a board.</p>`}
        ${st.orgs.length ? html`<p class="tiny-note">Organizations: ${st.orgs.map((o, i) => html`${i ? ' · ' : nothing}<a href=${boardsUrl(o)}>${o}</a>`)}</p>` : nothing}
        ${!st.groups ? html`<p class="muted">${st.err || 'Loading boards…'}</p>`
          : missing ? html`<p class="muted">Boards are not available on this API yet.</p>`
          : rows.length
            ? html`<ul class="repo-list">${rows.map(({ org, board: b }) => {
                const id = boardKey(b);
                return html`<li class="repo-item">
                  <a href=${boardUrl(org, id)}><strong>${b.name || id}</strong></a>
                  <span class="tiny-note">${org}${b.tag ? ` · tag: ${b.tag}` : ''}${b.state ? ` · ${b.state}` : ''}</span>
                </li>`;
              })}</ul>`
            : html`<p class="muted">${st.orgs.length ? 'No boards yet.' : 'Pick an organization to view its boards.'}</p>`}
      </div></div>`;
    },
    load: async (rerender) => {
      if (getAuth()?.token && !getMe()) await refreshMe();
      const orgs = await loadVisibleOrgNames();
      st.orgs = orgs;
      const mine = ownerChoices().map((o) => o.id);
      if (!st.orgSel && mine.length) st.orgSel = mine[0];
      else if (!st.orgSel && orgs.length) st.orgSel = orgs[0];
      if (!orgs.length) {
        st.groups = [];
        rerender();
        return;
      }
      const groups = await Promise.all(orgs.map(async (o) => ({ org: o, result: await fetchOrgBoards(o) })));
      st.groups = groups;
      rerender();
    },
  };
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
    reviews: null,
    copied: false,
    cliTab: 'Clone',
    diff: null,
    membership: null,
    prBusy: '',
    prErr: '',
    tab: opts.tab || 'code',
    kind: opts.kind || 'tree',
    ref: opts.ref || 'main',
    path: opts.path || '',
    pullNo: opts.pull || null,
    prTab: opts.prTab || 'conversation',
    comments: null,
    approvals: null,
    editing: false,
    editTitle: '',
    editBody: '',
    editBusy: false,
    convDraft: '',
    convBusy: false,
    inlineDraft: null,
    inlineBusy: false,
    expanded: {},
    commentErr: '',
    approveBusy: false,
    owners: null,
    ownerDraft: '',
    ownerBusy: false,
    ownerErr: '',
    deleteConfirm: '',
    deleteBusy: false,
    deleteErr: '',
    mergeability: null,
    checks: null,
    checkOpen: {},
    checkLogs: {},
    checkBusy: '',
    openResolved: new Set(),
    // PR create
    prCreate: { base: opts.ref || 'main', head: '', title: '', body: '', fixesText: '', draft: false, busy: false, err: '' },
    mergeMethod: 'fast-forward',
    // Issues
    issues: null,
    issueNo: opts.issue || null,
    issue: null,
    issueBusy: false,
    issueErr: '',
    issueDraft: { title: '', body: '', tag: '', busy: false, err: '' },
    issueEditing: false,
    issueEditTitle: '',
    issueEditBody: '',
    issueEditTag: '',
    issueEditBusy: false,
    issueComments: null,
    issueConvDraft: '',
    issueConvBusy: false,
    issueCommentErr: '',
    issueCommentEditing: null,
    // Fork
    forkBusy: false,
    forkErr: '',
    forkApiMissing: false,
  };
  const cloneCmd = `scn clone ${full}`;

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
      <span class="tiny-note">${c.author ? userLink(c.author, c.author) : ''}</span>
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
              <td class="size">${k === 'dir' ? '' : fmtSize(entrySize(e))}</td>
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
    if (!b.bytes) {
      const rawErr = b.spError || b.error || b.loadError || '';
      const engineRef = isRefNotFoundMessage(rawErr);
      const msg = engineRef || b.loadError
        ? (b.loadError || 'Could not load file.')
        : (b.spError ? `Could not fetch bytes from the storage provider: ${b.spError}` : 'Could not fetch bytes from the storage provider.');
      return html`<div class="card binary-note">
        <p>${msg}</p>
        ${!engineRef && url ? html`<p>Raw SP URL: <a href=${url} data-external target="_blank" rel="noopener">${url}</a></p>` : nothing}
        ${!engineRef && range ? html`<p>Range: <code>${range}</code></p>` : nothing}
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
    const name = st.path.split('/').pop() || '';
    let mdPreview = nothing;
    if (isMarkdownName(name) && text) {
      const rendered = b.mdTemplate
        || renderMarkdown(text, { org, repo, ref: st.ref, dir: parentDir(st.path) }, b.mdImages).template;
      mdPreview = html`<div class="readme-wrap card blob-md-preview" aria-label="Rendered markdown">
        <div class="readme-head">Preview</div>
        ${rendered}
      </div>`;
    }
    return html`
      <div class="blob-head"><span>${name} · ${fmtSize(size)} ${rawLink}</span>
        ${range ? html`<span class="tiny-note"><code>${range}</code></span>` : nothing}</div>
      <div class="blob-frame with-head">${codeBlock(st.path, lines.join('\n'), lines.length)}</div>
      ${truncated ? html`<p class="tiny-note">Preview truncated.</p>` : nothing}
      ${mdPreview}`;
  };

  const readmeView = () => {
    if (st.kind !== 'tree') return nothing;
    const r = st.readme;
    if (!r) return nothing;
    if (r.loading) return readmeCard(r.name || 'README', nothing, { loading: true });
    if (!r.bytes) return nothing;
    if (!isLikelyText(r.bytes, r.name)) return nothing;
    if (r.template) return readmeCard(r.name, r.template);
    if (isMarkdownName(r.name)) {
      const text = decodeUtf8(r.bytes);
      if (text) {
        const rendered = renderMarkdown(text, { org, repo, ref: st.ref, dir: st.path }, r.images);
        return readmeCard(r.name, rendered.template);
      }
    }
    return readmeCard(r.name, html`<pre><code>${decodeUtf8(r.bytes)}</code></pre>`);
  };

  const cliSnippets = {
    Clone: [cloneCmd, `scn clone ${full} ./${repo} --branch ${st.ref}`],
    Branch: [
      'scn branch',
      `scn branch new my-feature --from ${st.ref}`,
      'scn branch switch my-feature',
      'scn branch delete old-feature',
    ],
    Pull: ['scn pull'],
    Merge: [
      `scn merge ${st.ref === 'main' ? 'main' : st.ref}`,
      '# if both sides changed a path, resolve git-style markers, then:',
      'scn push -m "merge main"',
    ],
    Push: ['scn push', 'scn push -m "describe the change"'],
    PR: [
      'scn pr create --title "My change"',
      'scn pr create --title "My change" --body "details"',
      'scn pr list',
      'scn pr show 1',
      'scn pr merge 1',
      'scn pr close 1',
    ],
  };
  const cliPanel = () => html`
    <div class="cli-panel card">
      <h3 style="margin-top:0">CLI</h3>
      <p class="tiny-note">${ENV}</p>
      <div class="cli-tabs" role="tablist">
        ${Object.keys(cliSnippets).map((name) => html`<button type="button" role="tab"
          aria-selected=${st.cliTab === name ? 'true' : 'false'}
          @click=${() => { st.cliTab = name; draw(); }}>${name}</button>`)}
      </div>
      ${pre(cliSnippets[st.cliTab] || cliSnippets.Clone)}
      ${st.cliTab === 'Merge' ? html`<p>A conflicted file looks like:</p>${conflictSample()}` : nothing}
    </div>`;

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
    ${st.kind === 'blob' ? blobView() : html`${fileTable()}${readmeView()}`}
    ${forkPanel()}
    ${cliPanel()}`;

  function prApi(suffix, opts) {
    return api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}${suffix}`, opts);
  }

  async function toggleDraft(nextDraft) {
    if (!st.pullNo || st.prBusy) return;
    st.prErr = ''; st.prBusy = 'draft'; draw();
    try {
      if (nextDraft === false) {
        try { await prApi('/ready', { method: 'POST', auth: true, body: {} }); }
        catch { await prApi('', { method: 'PATCH', auth: true, body: { draft: false } }); }
      } else {
        try { await prApi('/draft', { method: 'POST', auth: true, body: {} }); }
        catch { await prApi('', { method: 'PATCH', auth: true, body: { draft: true } }); }
      }
      const s = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}`, null, { auth: true });
      st.pull = s;
      st.prBusy = '';
      await reloadMergeability();
      draw();
    } catch (e) {
      st.prErr = e.message || String(e);
      st.prBusy = '';
      draw();
    }
  }

  function isViewerOwner() {
    const viewer = st.info?.data?.viewer;
    if (viewer && typeof viewer.owner === 'boolean') return viewer.owner === true;
    const name = meName();
    if (name && ownerNames(asNamedList(st.owners?.data, 'owners')).includes(name)) return true;
    const owned = getMe()?.ownedRepos || [];
    return owned.some((r) => r && r.org === org && (r.name === repo || r.repo === repo));
  }

  async function reloadComments() {
    const s = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}/comments`, { comments: [] }, { auth: true });
    st.comments = s;
  }
  async function reloadApprovals() {
    const s = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}/approvals`, { approvals: [] }, { auth: true });
    st.approvals = s;
  }
  async function reloadReviews() {
    try {
      const s = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}/reviews`, { reviews: [] }, { auth: true });
      st.reviews = s;
    } catch {
      st.reviews = { live: false, status: 404, data: { reviews: [] } };
    }
  }
  async function reloadMergeability() {
    if (!st.pullNo) return;
    st.mergeability = await tryGet(
      `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}/mergeability`,
      null,
      { auth: true }
    );
  }
  async function reloadOwners() {
    st.owners = await tryGet(
      `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/owners`,
      { owners: [] },
      { auth: true }
    );
  }

  async function prAction(verb) {
    if (!st.pullNo || st.prBusy) return;
    st.prErr = ''; st.prBusy = verb; draw();
    try {
      const body = {};
      if (verb === 'merge' && st.mergeMethod) body.method = st.mergeMethod;
      const data = await prApi(`/${verb}`, { method: 'POST', auth: true, body });
      st.pull = { live: true, data };
      st.prBusy = '';
      if (verb === 'merge') await reloadMergeability();
      draw();
    } catch (e) {
      const reasons = Array.isArray(e.data?.reasons) ? e.data.reasons.map(formatMergeReason) : [];
      st.prErr = reasons.length ? `${e.message || 'merge blocked'}: ${reasons.join('; ')}` : (e.message || String(e));
      st.prBusy = '';
      draw();
    }
  }

  async function savePrEdit(e) {
    e.preventDefault();
    if (st.editBusy) return;
    st.commentErr = ''; st.editBusy = true; draw();
    try {
      const fixes = parseNumberList(st.editFixesText || '');
      const body = { title: st.editTitle, body: st.editBody };
      if (fixes.length) body.fixes = fixes;
      const data = await prApi('', { method: 'PATCH', auth: true, body });
      st.pull = { live: true, data: { ...(st.pull?.data || {}), ...data } };
      st.editing = false;
      st.editBusy = false;
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      st.editBusy = false;
      draw();
    }
  }

  async function postComment(payload) {
    return prApi('/comments', { method: 'POST', auth: true, body: payload });
  }

  async function deleteComment(id) {
    try {
      await prApi(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true });
    } catch (e) {
      if (e.status === 404) {
        await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/comments/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true });
      } else throw e;
    }
  }

  async function submitConvComment(e) {
    e.preventDefault();
    const body = (st.convDraft || '').trim();
    if (!body || st.convBusy) return;
    st.commentErr = ''; st.convBusy = true; draw();
    try {
      await postComment({ body });
      st.convDraft = '';
      await reloadComments();
      await reloadMergeability();
      st.convBusy = false;
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      st.convBusy = false;
      draw();
    }
  }

  async function submitInlineComment(e) {
    e.preventDefault();
    const draft = st.inlineDraft;
    const body = (draft?.body || '').trim();
    if (!draft || !body || st.inlineBusy) return;
    st.commentErr = ''; st.inlineBusy = true; draw();
    try {
      await postComment({ body, path: draft.path, line: draft.line, side: draft.side });
      st.inlineDraft = null;
      await reloadComments();
      await reloadMergeability();
      st.inlineBusy = false;
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      st.inlineBusy = false;
      draw();
    }
  }

  async function onDeleteComment(id) {
    st.commentErr = '';
    try {
      await deleteComment(id);
      await reloadComments();
      await reloadMergeability();
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      draw();
    }
  }

  async function toggleResolved(c, resolved) {
    if (!c?.id) return;
    st.commentErr = '';
    try {
      await prApi(`/comments/${encodeURIComponent(c.id)}`, { method: 'PATCH', auth: true, body: { resolved } });
      await reloadComments();
      await reloadMergeability();
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      draw();
    }
  }

  async function toggleApproval() {
    if (st.approveBusy) return;
    st.commentErr = ''; st.approveBusy = true; draw();
    const mine = iApproved(asNamedList(st.approvals?.data, 'approvals'));
    try {
      await prApi('/approvals', { method: mine ? 'DELETE' : 'POST', auth: true, body: mine ? undefined : {} });
      await reloadApprovals();
      await reloadMergeability();
      st.approveBusy = false;
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      st.approveBusy = false;
      draw();
    }
  }
  async function requestChanges() {
    if (st.approveBusy) return;
    st.commentErr = ''; st.approveBusy = true; draw();
    try {
      await prApi('/reviews', { method: 'POST', auth: true, body: { state: 'changes_requested' } });
      await reloadReviews();
      await reloadMergeability();
      st.approveBusy = false;
      draw();
    } catch (err) {
      st.commentErr = err.message || String(err);
      st.approveBusy = false;
      draw();
    }
  }

  const commentBlock = (c) => {
    const resolved = commentIsResolved(c);
    const canResolve = commentCanResolve(c, st.pull?.data);
    const expanded = !resolved || st.openResolved.has(c.id);
    const toggleOpen = (e) => {
      e.preventDefault();
      if (st.openResolved.has(c.id)) st.openResolved.delete(c.id);
      else st.openResolved.add(c.id);
      draw();
    };
    return html`
    <div class=${`pr-comment${resolved ? ' is-resolved' : ''}${resolved && !expanded ? ' is-collapsed' : ''}`}>
      <div class="pr-comment-meta">
        <strong>${userLink(c.author || c.user || c.author_name)}</strong>
        <span class="tiny-note">${fmtTime(c.created_at)}</span>
        ${resolved && !expanded ? html`<span class="tiny-note">Resolved comment</span>` : nothing}
        ${resolved ? html`<button class="btn btn-ghost btn-tiny" type="button" @click=${toggleOpen}>${expanded ? 'Hide' : 'Show'}</button>` : nothing}
        <label class="resolve-toggle">
          <input type="checkbox" .checked=${resolved} ?disabled=${!canResolve || !c.id}
            @click=${(e) => e.stopPropagation()}
            @change=${(e) => { e.stopPropagation(); toggleResolved(c, e.target.checked); }} />
          Resolved
        </label>
        ${commentIsMine(c) && c.id ? html`<button class="btn btn-ghost btn-tiny" type="button" @click=${() => onDeleteComment(c.id)}>Delete</button>` : nothing}
      </div>
      ${expanded ? html`<div class="pr-comment-body">${c.body || ''}</div>` : nothing}
    </div>`;
  };

  const signInHint = () => html`<p class="tiny-note"><a href=${`/#/login?next=${encodeURIComponent(location.pathname + location.hash)}`}>Sign in to comment</a></p>`;

  const conversationPane = (d) => {
    const author = d.author || d.author_name || 'unknown';
    const head = d.head_ref || d.head || '';
    const base = d.base_ref || d.base || 'main';
    const state = d.state || 'open';
    const open = state === 'open';
    const isDraft = d.draft === true || String(d.state || '').toLowerCase() === 'draft' || d.is_draft === true;
    const isAuthor = meIsPrAuthor(d);
    const viewer = st.info?.data?.viewer;
    const canMerge = open && (viewer && typeof viewer.canMerge === 'boolean'
      ? viewer.canMerge
      : (getMe()?.user?.admin || st.membership?.admin || st.membership?.member || isOrgMember(org) || isViewerOwner()));
    const canClose = open && (getMe()?.user?.admin || st.membership?.admin || isAuthor);
    const comments = asNamedList(st.comments?.data, 'comments').filter(isGeneralComment);
    const approvals = asNamedList(st.approvals?.data, 'approvals');
    const reviews = asNamedList(st.reviews?.data, 'reviews').filter((r) => String(r.state || '').toLowerCase() === 'changes_requested');
    const owners = asNamedList(st.owners?.data, 'owners');
    const signedIn = !!getAuth()?.token;
    const canApprove = signedIn && !isAuthor && open;
    const approved = iApproved(approvals);
    const prAuthor = d.author || d.author_name || d.user || '';
    const approvalCounts = (a) => approvalIsOwner(a, owners) && (a.user || a.author) !== prAuthor;
    const ownerApprovals = approvals.filter(approvalCounts);
    const needApprovals = (mergeLive0(st) && st.mergeability.data.requiredApprovals) || 1;
    const mergeLive = st.mergeability?.live === true && st.mergeability.data;
    const mergeBlocked = (isDraft) || (mergeLive && st.mergeability.data.mergeable === false);
    const mergeReasons = mergeLive
      ? (st.mergeability.data.reasons || []).map(formatMergeReason)
      : [];
    if (mergeLive && !mergeReasons.length && mergeBlocked) {
      const n = st.mergeability.data.unresolvedComments;
      if (st.mergeability.data.ownerApprovals === 0) mergeReasons.push('Needs approval from a repo owner');
      if (n > 0) mergeReasons.push(n === 1 ? '1 unresolved comment' : `${n} unresolved comments`);
    }
    const explainDisabled = (msg) => { alert(msg); };
    return html`
      <div class="card pr-title-box">
        ${st.editing ? html`
          <form class="form" @submit=${savePrEdit}>
            <label for="pr-edit-title">Title</label>
            <input id="pr-edit-title" type="text" .value=${st.editTitle} @input=${(e) => { st.editTitle = e.target.value; }} required />
            <label for="pr-edit-body">Description</label>
            <textarea id="pr-edit-body" rows="8" .value=${st.editBody} @input=${(e) => { st.editBody = e.target.value; }}></textarea>
            <label for="pr-edit-fixes"><strong>Fixes</strong> <span class="tiny-note">issue numbers, comma- or space-separated</span></label>
            <input id="pr-edit-fixes" type="text" placeholder="12, 15" .value=${st.editFixesText || ''} @input=${(e) => { st.editFixesText = e.target.value; }} />
            <div class="form-actions">
              <button class="btn btn-primary" type="submit" ?disabled=${st.editBusy}>${st.editBusy ? 'Saving…' : 'Save'}</button>
              <button class="btn" type="button" @click=${() => { st.editing = false; draw(); }}>Cancel</button>
            </div>
          </form>` : html`
          <div class="pr-title-row">
            <h2>#${d.number ?? st.pullNo} ${d.title || ''}</h2>
            ${isAuthor ? html`<button class="btn" type="button" @click=${() => { st.editing = true; st.editTitle = d.title || ''; st.editBody = d.body || ''; st.editFixesText = Array.isArray(d.fixes) ? d.fixes.join(', ') : ''; draw(); }}>Edit</button>` : nothing}
          </div>
          <div class="pr-meta-row">
            <span class="badge pr-state">${isDraft ? 'draft' : state}</span>
            <span>${userLink(author)}</span>
            <span class="mono">${head} → ${base}</span>
            <span class="tiny-note">${fmtTime(d.created_at)}</span>
          </div>
          ${Array.isArray(d.fixes) && d.fixes.length ? html`<p class="tiny-note">
            Fixes: ${d.fixes.map((n, i) => html`${i ? ', ' : nothing}<a href=${repoUrl(org, repo, ['issues', String(n)])}>#${n}</a>`)}
            <br />Merging this pull request will close those issues.
          </p>` : nothing}
          ${d.body ? html`<div class="md-body">${(() => { const r = renderMarkdown(d.body, { org, repo, ref: head || st.ref, dir: '' }); return r.template; })()}</div>` : html`<p class="muted">No description.</p>`}
        `}
      </div>
      <section class="pr-comments" aria-label="Conversation">
        <h3>Comments</h3>
        ${!st.comments ? html`<p class="muted">Loading comments…</p>`
          : comments.length ? comments.map(commentBlock)
          : html`<p class="muted">${st.comments.live === false && st.comments.status === 404 ? 'Comments are not available on this API yet.' : 'No comments yet.'}</p>`}
        ${signedIn ? html`<form class="card form pr-add-comment" @submit=${submitConvComment}>
          <label for="pr-conv-body">Add comment</label>
          <textarea id="pr-conv-body" rows="4" @input=${(e) => { st.convDraft = e.target.value; }} .value=${st.convDraft}></textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.convBusy || !(st.convDraft || '').trim()}>${st.convBusy ? 'Posting…' : 'Comment'}</button></div>
        </form>` : signInHint()}
      </section>
      ${checksSection(false)}
      <section class="pr-approvals" aria-label="Approvals">
        <h3>Approvals (${ownerApprovals.length} of ${needApprovals} required)</h3>
        ${!st.reviews ? nothing
          : (st.reviews.live === false && st.reviews.status === 404) ? html`<p class="muted">Reviews are not available on this API yet.</p>`
          : (reviews.length ? html`<ul class="pr-approval-list">${reviews.map((r) => html`<li>
              <strong>${userLink(r.user || r.author)}</strong>
              <span class="owner-badge">changes requested</span>
              <span class="tiny-note">${fmtTime(r.created_at)}</span>
            </li>`)}</ul>` : nothing)
        }
        ${!st.approvals ? html`<p class="muted">Loading approvals…</p>`
          : approvals.length ? html`<ul class="pr-approval-list">${approvals.map((a) => html`<li>
              <strong>${userLink(a.user || a.author)}</strong>
              ${approvalIsOwner(a, owners) ? html`<span class="owner-badge">owner</span>` : nothing}
              ${approvalCounts(a) ? nothing : html`<span class="tiny-note">(does not count${approvalIsOwner(a, owners) ? ': author' : ': not an owner'})</span>`}
              <span class="tiny-note">${fmtTime(a.created_at)}</span>
            </li>`)}</ul>`
          : (st.approvals.live === false && st.approvals.status === 404 ? html`<p class="muted">Approvals are not available on this API yet.</p>` : nothing)}
        <p class="tiny-note">${ownerApprovals.length} of ${needApprovals} required owner approval${needApprovals === 1 ? '' : 's'}</p>
        ${canApprove ? html`<div class="form-actions">
          <button class="btn ${approved ? '' : 'btn-primary'}" type="button" ?disabled=${st.approveBusy} @click=${toggleApproval}>${st.approveBusy ? 'Working…' : (approved ? 'Remove approval' : 'Approve')}</button>
          <button class="btn" type="button" ?disabled=${st.approveBusy} @click=${requestChanges}>${st.approveBusy ? 'Working…' : 'Request changes'}</button>
        </div>` : nothing}
      </section>
      ${open ? html`<div class="pr-actions">
        ${canMerge ? html`
          <label class="choice" style="margin-right:.5rem">
            <span class="tiny-note">Merge method</span>
            <select @change=${(e) => { st.mergeMethod = e.target.value; draw(); }}>
              ${['fast-forward', 'squash'].map((m) => html`<option value=${m} ?selected=${st.mergeMethod === m}>${m === 'fast-forward' ? 'Fast-forward' : 'Squash'}</option>`)}
            </select>
          </label>
          <button class="btn btn-primary" type="button" ?disabled=${!!st.prBusy || mergeBlocked} @click=${() => prAction('merge')}>${st.prBusy === 'merge' ? 'Merging…' : (st.mergeMethod === 'squash' ? 'Merge (Squash)' : 'Merge')}</button>` : nothing}
        ${canClose ? html`<button class="btn" type="button" ?disabled=${!!st.prBusy} @click=${() => prAction('close')}>${st.prBusy === 'close' ? 'Closing…' : 'Close'}</button>` : nothing}
        ${!canMerge && !canClose ? html`
          <span class="btn disabled" role="button" aria-disabled="true" tabindex="0"
            title="Sign in as an org member to review this pull request"
            @click=${() => explainDisabled('Sign in as an org member to review this pull request')}
            @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') explainDisabled('Sign in as an org member to review this pull request'); }}>
            Review
          </span>
          <span class="btn disabled" role="button" aria-disabled="true" tabindex="0"
            title="Sign in as the author or an admin to close this pull request"
            @click=${() => explainDisabled('Sign in as the author or an admin to close this pull request')}
            @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') explainDisabled('Sign in as the author or an admin to close this pull request'); }}>
            Close
          </span>
        ` : nothing}
        ${isAuthor ? html`${isDraft
            ? html`<button class="btn" type="button" ?disabled=${!!st.prBusy} @click=${() => toggleDraft(false)}>${st.prBusy === 'draft' ? 'Working…' : 'Ready for review'}</button>`
            : html`<button class="btn" type="button" ?disabled=${!!st.prBusy} @click=${() => toggleDraft(true)}>${st.prBusy === 'draft' ? 'Working…' : 'Convert to draft'}</button>`}` : nothing}
      </div>
      ${mergeBlocked && mergeReasons.length ? html`<ul class="merge-reasons">${mergeReasons.map((r) => html`<li>${r}</li>`)}</ul>` : nothing}
      ${st.mergeability?.live === false && st.mergeability.status === 404 ? html`<p class="tiny-note">Mergeability checks are not available on this API yet.</p>` : nothing}` : nothing}
      ${st.prErr || st.commentErr ? html`<p class="form-error">${st.prErr || st.commentErr}</p>` : nothing}
    `;
  };

  const inlineForm = (path, line, side) => {
    const signedIn = !!getAuth()?.token;
    if (!signedIn) return html`<tr class="comment-row"><td colspan="4"><div class="pr-sticky">${signInHint()}</div></td></tr>`;
    const draft = st.inlineDraft;
    return html`<tr class="comment-row"><td colspan="4"><div class="pr-sticky">
      <form class="form pr-inline-form" @submit=${submitInlineComment}>
        <textarea rows="3" placeholder="Comment" .value=${draft?.body || ''} @input=${(e) => { if (st.inlineDraft) st.inlineDraft.body = e.target.value; }}></textarea>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" ?disabled=${st.inlineBusy || !(draft?.body || '').trim()}>${st.inlineBusy ? 'Saving…' : 'Save'}</button>
          <button class="btn" type="button" @click=${() => { st.inlineDraft = null; draw(); }}>Cancel</button>
        </div>
      </form>
    </div></td></tr>`;
  };

  const diffLineRow = (filePath, ln) => {
    const side = ln.t === 'del' ? 'old' : 'new';
    const line = side === 'old' ? ln.oldNo : ln.newNo;
    const mark = ln.t === 'add' ? '+' : ln.t === 'del' ? '-' : ' ';
    const open = () => {
      if (st.inlineDraft && st.inlineDraft.path === filePath && st.inlineDraft.line === line && st.inlineDraft.side === side) {
        st.inlineDraft = null;
      } else {
        st.inlineDraft = { path: filePath, line, side, body: '' };
      }
      draw();
    };
    const highlighted = ln.t !== 'del' && ln.html != null && ln.html !== '';
    const code = highlighted ? unsafeHTML(ln.html) : ln.s;
    return html`<tr class=${`diff-line ${ln.t}`} @click=${open}>
      <td class="ln old">${ln.oldNo || ''}</td>
      <td class="ln new">${ln.newNo || ''}</td>
      <td class="mark">${mark}</td>
      <td class="src"><code class=${highlighted ? 'hljs' : ''}>${code}</code></td>
    </tr>`;
  };

  const fileDiffView = (d, row) => {
    const headRef = d.head_target || d.head_ref || d.head || st.ref;
    const comments = asNamedList(st.comments?.data, 'comments');
    const expanded = st.expanded[row.path] || [];
    const hunks = row.lines ? hunkifyDiff(row.lines, expanded) : [];
    const expand = (gap) => {
      st.expanded[row.path] = [...(st.expanded[row.path] || []), [gap.start, gap.end]];
      draw();
    };
    const blobHref = blobUrl(org, repo, headRef, row.path);
    const lineBlock = (h) => {
      const ln = h.row;
      const side = ln.t === 'del' ? 'old' : 'new';
      const line = side === 'old' ? ln.oldNo : ln.newNo;
      const cms = lineComments(comments, row.path, line, side);
      const draft = st.inlineDraft;
      const showForm = draft && draft.path === row.path && draft.line === line && draft.side === side;
      // Comment blocks are sibling rows, never inside the code cell / highlight pass.
      return html`${diffLineRow(row.path, ln)}
        ${cms.map((c) => html`<tr class="comment-row"><td colspan="4"><div class="pr-sticky">${commentBlock(c)}</div></td></tr>`)}
        ${showForm ? inlineForm(row.path, line, side) : nothing}`;
    };
    const blocks = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      blocks.push(html`<table class="diff-table"><tbody>${buf}</tbody></table>`);
      buf = [];
    };
    for (const h of hunks) {
      if (h.kind === 'gap') {
        flush();
        blocks.push(html`<div class="diff-expand-bar"><button type="button" class="diff-expand" @click=${() => expand(h)}>Expand ${h.count} hidden line${h.count === 1 ? '' : 's'}</button></div>`);
      } else buf.push(lineBlock(h));
    }
    flush();
    return html`<div class="diff-file">
      <div class="diff-file-head">
        <span class="st ${row.status === 'added' ? 'add' : row.status === 'removed' ? 'del' : 'mod'}">${row.status}</span>
        <span class="diff-path">${row.path}</span>
        <a href=${blobHref} target="_blank" rel="noopener">View full file</a>
        ${row.skip ? html`<span class="tiny-note">${row.skip}</span>` : nothing}
      </div>
      ${row.lines ? html`<div class="diff-hunk-wrap">${blocks}</div>` : html`<p class="tiny-note" style="padding:.6rem .8rem">${row.skip || 'No diff.'}</p>`}
    </div>`;
  };

  const filesPane = (d) => {
    const files = st.diff?.files || [];
    const head = d.head_ref || d.head || '';
    const base = d.base_ref || d.base || 'main';
    return html`
      ${!st.diff ? html`<p class="muted">Loading diff…</p>`
        : st.diff.error ? html`<p class="muted">Could not load files (${base}…${head}): ${st.diff.error}</p>`
        : html`
          <ul class="diff-list">${files.map((f) => html`<li class="diff-item"><span class="st ${f.status === 'added' ? 'add' : f.status === 'removed' ? 'del' : 'mod'}">${f.status}</span> ${f.path}</li>`)}</ul>
          ${st.diff.truncated ? html`<p class="tiny-note">Showing ${st.diff.rows?.length || 0} of ${st.diff.total} files.</p>` : nothing}
          ${(st.diff.rows || []).map((row) => fileDiffView(d, row))}
        `}
      ${st.commentErr ? html`<p class="form-error">${st.commentErr}</p>` : nothing}
    `;
  };

  async function loadChecks() {
    if (!st.pullNo) return;
    const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
    st.checks = await tryGet(`${b}/checks?pr=${encodeURIComponent(st.pullNo)}`, null);
    for (const id of Object.keys(st.checkOpen)) if (st.checkOpen[id]) loadCheckLog(id, true);
    draw();
    clearTimeout(st.checksTimer);
    const list = st.checks?.data?.checks || [];
    if (list.some((c) => c.state === 'queued' || c.state === 'running') && location.hash.includes(`/pulls/${st.pullNo}`)) {
      st.checksTimer = setTimeout(loadChecks, 4000);
    }
  }
  async function loadCheckLog(id, quiet) {
    const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
    try {
      const r = await fetch(`${API}${b}/checks/${encodeURIComponent(id)}/log`);
      st.checkLogs[id] = r.ok ? await r.text() : `could not load log (${r.status})`;
    } catch (e) { st.checkLogs[id] = `could not load log: ${e.message}`; }
    if (!quiet) draw();
  }
  function toggleCheck(id) {
    st.checkOpen[id] = !st.checkOpen[id];
    if (st.checkOpen[id] && st.checkLogs[id] == null) loadCheckLog(id);
    draw();
  }
  async function rerunCheck(name) {
    st.checkBusy = name; draw();
    try {
      await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/checks/rerun`, { method: 'POST', auth: true, body: { name, pr: Number(st.pullNo) } });
      for (const c of st.checks?.data?.checks || []) if (c.name === name) { delete st.checkLogs[c.id]; }
    } catch (e) { st.prErr = e.message || String(e); }
    st.checkBusy = '';
    await loadChecks();
    try { st.mergeability = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(st.pullNo)}/mergeability`, null, { auth: true }); } catch { /* ignore */ }
    draw();
  }
  const checksSummaryLine = () => {
    const data = st.checks?.data;
    if (!st.checks) return html`<span class="tiny-note">Loading checks…</span>`;
    if (!st.checks.live || !data) return nothing;
    const list = data.checks || [];
    const { counts, missing, overall } = checksRollup(list, data.required);
    if (!list.length && !missing.length) return html`<span class="tiny-note">No checks</span>`;
    const parts = ['success', 'failure', 'error', 'running', 'queued', 'cancelled'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
    if (missing.length) parts.push(`${missing.length} required not reported`);
    return html`<span class="checks-rollup check-${overall}"><span class="check-icon">${CHECK_ICON[overall === 'none' ? 'queued' : overall] || '○'}</span> Checks: ${parts.join(', ')}</span>`;
  };
  const checksSection = (compact) => {
    const data = st.checks?.data;
    const owner = isViewerOwner();
    const list = data?.checks || [];
    const required = new Set(data?.required || []);
    const missing = [...required].filter((n) => !list.some((c) => c.name === n));
    return html`<section class="pr-checks ${compact ? 'compact' : ''}" aria-label="Checks">
      <div class="checks-head"><h3>Checks</h3> ${checksSummaryLine()}
        ${data ? html`<span class="tiny-note mono" title=${data.changeset}>on ${String(data.changeset).slice(0, 12)}</span>` : nothing}</div>
      ${!st.checks ? nothing
        : !st.checks.live ? html`<p class="muted">Checks are not available on this API yet.</p>`
        : !list.length && !missing.length ? html`<p class="muted">No checks on this changeset. Add <code>.scionbase/ci.yml</code> and a runner, or push results with <code>scn ci report</code>. <a href="/#/ci">How CI works</a>.</p>`
        : html`<ul class="check-list">
          ${list.map((c) => html`<li class="check-item check-${c.state}">
            <div class="check-row">
              <button class="check-toggle" type="button" aria-expanded=${st.checkOpen[c.id] ? 'true' : 'false'} @click=${() => toggleCheck(c.id)}>
                <span class="check-icon" aria-label=${c.state}>${CHECK_ICON[c.state] || '?'}</span>
                <strong>${c.name}</strong>
                ${required.has(c.name) ? html`<span class="owner-badge">required</span>` : nothing}
                <span class="check-state">${c.state}</span>
                ${c.summary ? html`<span class="check-summary">${c.summary}</span>` : nothing}
              </button>
              <span class="check-meta">
                ${c.duration_ms != null ? html`<span>${fmtDuration(c.duration_ms)}</span>` : nothing}
                ${c.runner ? html`<span class="tiny-note">on ${c.runner}</span>` : c.reported_by ? html`<span class="tiny-note">by ${c.reported_by}</span>` : nothing}
                ${c.attempt > 1 ? html`<span class="tiny-note">attempt ${c.attempt}</span>` : nothing}
                ${c.target_url ? html`<a href=${c.target_url} target="_blank" rel="noopener">details</a>` : nothing}
                ${owner && c.rerunnable && c.state !== 'queued' && c.state !== 'running' ? html`<button class="btn btn-tiny" type="button" ?disabled=${st.checkBusy === c.name} @click=${() => rerunCheck(c.name)}>${st.checkBusy === c.name ? 'Queuing…' : 'Re-run'}</button>` : nothing}
              </span>
            </div>
            ${st.checkOpen[c.id] ? html`<pre class="check-log"><code>${st.checkLogs[c.id] == null ? 'Loading log…' : (st.checkLogs[c.id] || '(empty log)')}</code></pre>` : nothing}
          </li>`)}
          ${missing.map((n) => html`<li class="check-item check-missing"><div class="check-row"><span class="check-toggle"><span class="check-icon">○</span> <strong>${n}</strong> <span class="owner-badge">required</span> <span class="check-state">not reported yet</span></span></div></li>`)}
        </ul>`}
    </section>`;
  };

  const pullsTab = () => {
    if (st.pullNo === 'new') {
      const bnames = [st.ref, ...((st.branches?.data?.branches || []).map((b) => (typeof b === 'string' ? b : b.name)))].filter((n, i, a) => n && a.indexOf(n) === i);
      const f = st.prCreate;
      const submit = async (e) => {
        e.preventDefault();
        if (f.busy) return;
        f.err = ''; f.busy = true; draw();
        try {
          const fixes = parseNumberList(f.fixesText || '');
          const payload = { title: String(f.title || '').trim(), body: String(f.body || ''), base: String(f.base || 'main'), head: String(f.head || ''), draft: !!f.draft };
          if (fixes.length) payload.fixes = fixes;
          if (!payload.title) throw new Error('title is required');
          if (!payload.head) throw new Error('select a head branch');
          const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls`, { method: 'POST', auth: true, body: payload });
          const num = data?.number || data?.id;
          if (!num) throw new Error('pull create did not return a number');
          navigate(repoUrl(org, repo, ['pulls', String(num)]));
        } catch (e2) {
          f.err = e2.message || String(e2);
          f.busy = false; draw();
        }
      };
      return html`<div class="narrow"><h2 style="margin-top:0">New pull request</h2>
        <form class="card form" @submit=${submit}>
          <label for="pr-base">Base branch</label>
          <select id="pr-base" .value=${f.base} @change=${(e) => { f.base = e.target.value; draw(); }}>
            ${bnames.map((n) => html`<option value=${n} ?selected=${n === f.base}>${n}</option>`)}
          </select>
          <label for="pr-head">Head branch</label>
          <select id="pr-head" .value=${f.head} @change=${(e) => { f.head = e.target.value; draw(); }}>
            ${bnames.map((n) => html`<option value=${n} ?selected=${n === f.head}>${n}</option>`)}
          </select>
          <label for="pr-title">Title</label>
          <input id="pr-title" type="text" .value=${f.title} @input=${(e) => { f.title = e.target.value; }} required />
          <label for="pr-body">Description</label>
          <textarea id="pr-body" rows="6" .value=${f.body} @input=${(e) => { f.body = e.target.value; }}></textarea>
          <label for="pr-fixes"><strong>Fixes</strong> <span class="tiny-note">issue numbers, comma- or space-separated (e.g. 12, 15)</span></label>
          <input id="pr-fixes" type="text" placeholder="12, 15" .value=${f.fixesText || ''} @input=${(e) => { f.fixesText = e.target.value; }} />
          <label class="choice"><input type="checkbox" .checked=${!!f.draft} @change=${(e) => { f.draft = e.target.checked; draw(); }} /> Create as draft</label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" ?disabled=${f.busy}>${f.busy ? 'Creating…' : 'Create pull request'}</button>
            <a class="btn" href=${repoUrl(org, repo, ['pulls'])}>Cancel</a>
          </div>
          ${f.err ? html`<p class="form-error">${f.err}</p>` : nothing}
        </form></div>`;
    }
    if (st.pullNo) {
      const p = st.pull;
      if (!p) return html`<p class="muted">Loading pull request…</p>`;
      if (!p.live) return html`<p class="muted">Could not load PR #${st.pullNo}: ${p.error}</p>`;
      const d = p.data || {};
      return html`
        <div class="pr-detail">
          <nav class="pr-subtabs" aria-label="Pull request">
            <a href=${pullUrl(org, repo, st.pullNo)} aria-current=${st.prTab !== 'files' ? 'page' : nothing}>Conversation</a>
            <a href=${pullUrl(org, repo, st.pullNo, 'files')} aria-current=${st.prTab === 'files' ? 'page' : nothing}>Code</a>
          </nav>
          ${st.prTab === 'files' ? html`<div class="pr-code-checks">${checksSection(true)}</div>${filesPane(d)}` : conversationPane(d)}
        </div>`;
    }
    const rows = pullList(st.pulls);
    return html`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
        <h2 style="margin:.2rem 0">Pull requests</h2>
        ${getAuth()?.token ? html`<a class="btn btn-primary" href=${repoUrl(org, repo, ['pulls', 'new'])}>New pull request</a>` : nothing}
      </div>
      ${!st.pulls ? html`<p class="muted">Loading…</p>`
        : !st.pulls.live ? html`<p class="muted">Couldn't load pull requests (${st.pulls.error}). Try <code>scn pr list</code>.</p>`
        : rows.length ? html`<ul class="repo-list">${rows.map((p) => html`<li class="repo-item pr-item" @click=${(e) => {
            if (e.target.closest('a')) return;
            navigate(repoUrl(org, repo, ['pulls', String(p.number)]));
          }}>
            <a class="pr-title" href=${repoUrl(org, repo, ['pulls', String(p.number)])}><strong>${p.title || `#${p.number}`}</strong></a>
            <span class="pr-author">${userLink(pullAuthorName(p))}</span>
            <span class="badge pr-state">${pullStatusLabel(p)}</span>
          </li>`)}</ul>`
        : html`<p class="muted">No pull requests.</p>`}
      ${cliPanel()}`;
  };

  function forkPanel() {
    const authed = !!getAuth()?.token;
    const owner = isViewerOwner();
    if (!authed || owner) return nothing;
    const tryFork = async () => {
      if (st.forkBusy) return;
      st.forkErr = ''; st.forkBusy = true; draw();
      try {
        const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/forks`, { method: 'POST', auth: true, body: {} });
        const o = data?.org || data?.owner || data?.namespace || getAuth()?.username;
        const r = data?.name || repo;
        if (o) navigate(repoUrl(o, r));
        else st.forkErr = 'Fork created, but could not determine URL';
      } catch (e) {
        if (e.status === 404 || e.status === 405) { st.forkApiMissing = true; st.forkErr = ''; }
        else st.forkErr = e.message || String(e);
      }
      st.forkBusy = false; draw();
    };
    const contributeBox = () => {
      const you = meName() || 'you';
      const sample = `users/${you}/my-change`;
      return html`<div class="card" style="margin-top:.75rem">
        <h3 style="margin:.2rem 0">Contribute without a fork</h3>
        <p class="tiny-note">Create a branch under <code>users/${you}/…</code> in this repo, push your changes, then open a pull request.</p>
        ${pre([ENV, `scn clone ${full}`, `cd ${repo}`, `scn branch new ${sample} --from ${st.ref}`, 'scn branch switch ' + sample, '# edit files', 'scn push -m "describe the change"', `# then open a PR on the web: ${location.origin}${repoUrl(org, repo, ['pulls', 'new'])}`])}
        <p class="tiny-note">In the PR form, choose base <code>${st.ref}</code> and head <code>${sample}</code>.</p>
      </div>`;
    };
    return html`<div style="margin:.9rem 0 0">
      ${!st.forkApiMissing ? html`<button class="btn" type="button" @click=${tryFork} ?disabled=${st.forkBusy}>${st.forkBusy ? 'Forking…' : 'Fork'}</button>` : nothing}
      ${st.forkErr ? html`<p class="form-error">${st.forkErr}</p>` : nothing}
      ${st.forkApiMissing ? contributeBox() : nothing}
    </div>`;
  }

  async function addOwner(e) {
    e.preventDefault();
    const username = (st.ownerDraft || '').trim();
    if (!username || st.ownerBusy) return;
    st.ownerErr = ''; st.deleteErr = ''; st.ownerBusy = true; draw();
    try {
      await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/owners`, {
        method: 'POST', auth: true, body: { username },
      });
      st.ownerDraft = '';
      await reloadOwners();
      st.ownerBusy = false;
      draw();
    } catch (err) {
      st.ownerErr = err.message || String(err);
      st.ownerBusy = false;
      draw();
    }
  }

  async function removeOwner(username) {
    if (!username || st.ownerBusy) return;
    st.ownerErr = ''; st.deleteErr = ''; st.ownerBusy = true; draw();
    try {
      await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/owners/${encodeURIComponent(username)}`, {
        method: 'DELETE', auth: true,
      });
      await reloadOwners();
      st.ownerBusy = false;
      draw();
    } catch (err) {
      st.ownerErr = err.message || String(err);
      st.ownerBusy = false;
      draw();
    }
  }

  async function deleteRepo(e) {
    e.preventDefault();
    const confirm = (st.deleteConfirm || '');
    if (confirm !== full || st.deleteBusy) return;
    st.deleteErr = ''; st.ownerErr = ''; st.deleteBusy = true; draw();
    try {
      const res = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, {
        method: 'DELETE', auth: true, body: { confirm },
      });
      st.deleteBusy = false;
      const n = (res && res.removedPieces) || 0;
      alert(`Deleted ${full}. Scheduled removal of ${n} stored piece${n === 1 ? '' : 's'} from Filecoin${res && res.tx ? ` (tx ${res.tx})` : ''}.`);
      navigate(orgUrl(org));
    } catch (err) {
      st.deleteErr = err.message || String(err);
      st.deleteBusy = false;
      draw();
    }
  }

  function mergeLive0(st) { return st.mergeability?.live === true && st.mergeability.data; }
  async function loadRepoSettings() {
    if (st.repoSettingsLoading) return;
    st.repoSettingsLoading = true;
    st.repoSettings = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/settings`, null, { auth: true });
    st.repoSettingsDraft = st.repoSettings?.data ? { ...st.repoSettings.data, checksText: (st.repoSettings.data.requiredChecks || []).join(', ') } : null;
    draw();
    loadRunners();
  }
  async function loadRunners() {
    st.runners = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/runners`, { runners: [] }, { auth: true });
    draw();
  }
  async function registerRunner(e) {
    e.preventDefault();
    st.runnerBusy = true; st.runnerErr = ''; st.runnerNew = null; draw();
    try {
      const labels = (st.runnerLabels || 'linux').split(',').map((x) => x.trim()).filter(Boolean);
      st.runnerNew = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/runners`, { method: 'POST', auth: true, body: { name: (st.runnerName || '').trim() || undefined, labels } });
      st.runnerName = '';
    } catch (err) { st.runnerErr = err?.message || String(err); }
    st.runnerBusy = false;
    await loadRunners();
  }
  async function removeRunner(name) {
    if (!confirm(`Remove runner ${name}? Its token stops working.`)) return;
    try { await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/runners/${encodeURIComponent(name)}`, { method: 'DELETE', auth: true }); }
    catch (err) { st.runnerErr = err?.message || String(err); }
    await loadRunners();
  }
  const runnersSection = () => {
    const list = st.runners?.data?.runners || [];
    const now = Date.now();
    const ago = (t) => { if (!t) return 'never'; const s = Math.round((now - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
    return html`<section aria-label="Runners">
      <h3>Runners</h3>
      <p class="tiny-note">Your own machines that run <code>.scionbase/ci.yml</code> jobs. They connect outbound only. <a href="/#/ci">Setup guide</a></p>
      ${!st.runners ? html`<p class="muted">Loading runners…</p>`
        : list.length ? html`<ul class="owner-list">${list.map((r) => html`<li>
            <span><strong>${r.name}</strong> <span class="mono tiny-note">${(r.labels || []).join(', ')}</span>
              <span class="tiny-note">last seen ${ago(r.last_seen)} · added by ${r.created_by}</span></span>
            <button class="btn btn-ghost btn-tiny" type="button" @click=${() => removeRunner(r.name)}>Remove</button>
          </li>`)}</ul>`
        : html`<p class="muted">No runners registered.</p>`}
      <form class="form owner-add" @submit=${registerRunner}>
        <label for="runner-name">Name <input id="runner-name" type="text" placeholder="build-box" .value=${st.runnerName || ''} @input=${(e) => { st.runnerName = e.target.value; }} /></label>
        <label for="runner-labels">Labels <input id="runner-labels" type="text" placeholder="linux,x64" .value=${st.runnerLabels ?? 'linux,x64'} @input=${(e) => { st.runnerLabels = e.target.value; }} /></label>
        <button class="btn btn-primary" type="submit" ?disabled=${st.runnerBusy}>${st.runnerBusy ? 'Registering…' : 'Register runner'}</button>
      </form>
      ${st.runnerNew ? html`<div class="card runner-token"><p><strong>Runner ${st.runnerNew.name} registered.</strong> Copy this token now; it is shown once.</p>
        ${pre([`mkdir -p ~/.config/scn/runners && umask 077 && cat > ~/.config/scn/runners/${org}__${repo}.json <<'EOF'`, JSON.stringify({ server: API, repo: `${org}/${repo}`, id: st.runnerNew.id, name: st.runnerNew.name, labels: st.runnerNew.labels, token: st.runnerNew.token }), 'EOF', `scn runner run --repo ${org}/${repo}`])}
        <p class="tiny-note">Or skip the web flow and run <code>scn runner register --repo ${org}/${repo} --labels linux,x64</code> on the machine.</p></div>` : nothing}
      ${st.runnerErr ? html`<p class="form-error">${st.runnerErr}</p>` : nothing}
    </section>`;
  };

  async function loadWebhooks() {
    try {
      st.webhooks = await tryGet(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/webhooks`, { webhooks: [] }, { auth: true });
    } catch {
      st.webhooks = { live: false, status: 404, data: { webhooks: [] } };
    }
    draw();
  }
  async function addWebhook(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    st.webhookErr = ''; st.webhookBusy = true; draw();
    try {
      const url = String(fd.get('url') || '').trim();
      const secret = String(fd.get('secret') || '').trim();
      const events = Array.from(e.target.querySelectorAll('input[name="ev"]:checked')).map((n) => n.value);
      await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/webhooks`, { method: 'POST', auth: true, body: { url, secret: secret || undefined, events } });
      e.target.reset();
      await loadWebhooks();
      st.webhookBusy = false; draw();
    } catch (err) { st.webhookErr = err?.message || String(err); st.webhookBusy = false; draw(); }
  }
  async function removeWebhook(id) {
    try {
      await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true });
      await loadWebhooks();
    } catch (err) { st.webhookErr = err?.message || String(err); draw(); }
  }
  function webhooksSection() {
    if (!st.webhooks) { loadWebhooks(); return html`<section aria-label="Webhooks"><h3>Webhooks</h3><p class="muted">Loading…</p></section>`; }
    if (st.webhooks.live === false && (st.webhooks.status === 404 || st.webhooks.status === 405)) {
      return html`<section aria-label="Webhooks"><h3>Webhooks</h3><p class="muted">Webhooks are not available on this API yet.</p></section>`;
    }
    const list = st.webhooks?.data?.webhooks || st.webhooks?.data?.hooks || [];
    return html`<section aria-label="Webhooks">
      <h3>Webhooks</h3>
      ${list.length ? html`<ul class="owner-list">${list.map((h) => html`<li>
        <span><strong>${h.url}</strong> ${Array.isArray(h.events) && h.events.length ? html`<span class="tiny-note">${h.events.join(', ')}</span>` : nothing}</span>
        <button class="btn btn-ghost btn-tiny" type="button" @click=${() => removeWebhook(h.id)}>Delete</button>
      </li>`)}</ul>` : html`<p class="muted">No webhooks configured.</p>`}
      <form class="form" @submit=${addWebhook}>
        <label for="wh-url">URL</label>
        <input id="wh-url" name="url" type="url" required placeholder="https://example.com/webhook" />
        <label for="wh-secret">Secret (optional)</label>
        <input id="wh-secret" name="secret" type="text" placeholder="signing secret" />
        <div class="choices">
          ${['push', 'pulls', 'issues', 'checks'].map((ev) => html`<label class="choice"><input type="checkbox" name="ev" value=${ev} /> ${ev}</label>`)}
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.webhookBusy}>${st.webhookBusy ? 'Saving…' : 'Add webhook'}</button></div>
        ${st.webhookErr ? html`<p class="form-error">${st.webhookErr}</p>` : nothing}
      </form>
    </section>`;
  }
  async function saveRepoSettings(e) {
    e.preventDefault();
    const dr = st.repoSettingsDraft; if (!dr) return;
    const n = Math.floor(Number(dr.requiredApprovals));
    if (!(n >= 1 && n <= 10)) { st.settingsErr = 'Required approvals must be between 1 and 10.'; draw(); return; }
    st.settingsBusy = true; st.settingsErr = ''; st.settingsMsg = ''; draw();
    try {
      const requiredChecks = String(dr.checksText || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const r = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/settings`, { method: 'PUT', auth: true, body: { protectMain: !!dr.protectMain, requiredApprovals: n, requiredChecks } });
      st.repoSettings = { live: true, data: r }; st.repoSettingsDraft = { ...r, checksText: (r.requiredChecks || []).join(', ') }; st.settingsMsg = 'Saved.';
    } catch (err) { st.settingsErr = err?.message || String(err); }
    st.settingsBusy = false; draw();
  }
  const settingsTab = () => {
    if (!getAuth()?.token) {
      return html`<h2 style="margin-top:0">Settings</h2>
        <p>Sign in as a repository owner to manage settings.</p>
        <p><a class="btn btn-primary" href=${`/#/login?next=${encodeURIComponent(location.pathname + location.hash)}`}>Sign in</a></p>`;
    }
    const ownersMissing = st.owners?.live === false && (st.owners.status === 404 || st.owners.status === 405);
    const viewerMissing = !st.info?.data?.viewer;
    if (!st.info || (st.owners == null && viewerMissing)) {
      return html`<p class="muted">Loading settings…</p>`;
    }
    if (!isViewerOwner()) {
      if (ownersMissing && viewerMissing) {
        return html`<h2 style="margin-top:0">Settings</h2>
          <p class="muted">Repository settings are not available on this API yet.</p>`;
      }
      return html`<h2 style="margin-top:0">Settings</h2>
        <p>Only repository owners can view these settings.</p>`;
    }
    const owners = asNamedList(st.owners?.data, 'owners');
    const confirmOk = st.deleteConfirm === full;
    return html`
      <h2 style="margin-top:0">Settings</h2>
      <section aria-label="Branch rules">
        <h3>Branch rules</h3>
        ${(() => { if (!st.repoSettings) { loadRepoSettings(); return html`<p class="muted">Loading…</p>`; }
          const dr = st.repoSettingsDraft; if (!dr) return html`<p class="muted">Settings are not available on this API yet.</p>`;
          return html`<form class="form" @submit=${saveRepoSettings}>
          <label class="check-row"><input type="checkbox" .checked=${!!dr.protectMain} @change=${(e) => { dr.protectMain = e.target.checked; draw(); }} />
            <span><strong>Protect main</strong><br><span class="tiny-note">Refuse direct pushes and ref changes to <code>main</code>; it changes only by merging a pull request. Cloning and reading are unaffected.</span></span></label>
          <label for="req-approvals"><strong>Require approval</strong> <span class="badge">always on</span><br>
            <span class="tiny-note">Owner approvals needed before a pull request can merge. The author's own approval never counts.</span></label>
          <input id="req-approvals" type="number" min="1" max="10" step="1" style="max-width:6rem" .value=${String(dr.requiredApprovals)}
            @input=${(e) => { dr.requiredApprovals = e.target.value; }} />
          <label for="req-checks"><strong>Required checks</strong><br>
            <span class="tiny-note">CI job names (comma-separated) that must be <code>success</code> on the PR head before merge. Leave empty for none.</span></label>
          <input id="req-checks" type="text" placeholder="vet, unit" .value=${dr.checksText || ''} @input=${(e) => { dr.checksText = e.target.value; }} />
          <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.settingsBusy}>${st.settingsBusy ? 'Saving…' : 'Save rules'}</button>
            ${st.settingsMsg ? html`<span class="tiny-note">${st.settingsMsg}</span>` : nothing}</div>
        </form>`; })()}
        ${st.settingsErr ? html`<p class="form-error">${st.settingsErr}</p>` : nothing}
      </section>
      ${runnersSection()}
      <section aria-label="Owners">
        <h3>Owners</h3>
        ${!st.owners ? html`<p class="muted">Loading owners…</p>`
          : ownersMissing ? html`<p class="muted">Owner management is not available on this API yet.</p>`
          : owners.length ? html`<ul class="owner-list">${owners.map((o) => html`<li>
              <span><strong>${userLink(o.user || o.user_name)}</strong>
                ${o.added_by ? html`<span class="tiny-note">added by ${userLink(o.added_by, o.added_by)}</span>` : nothing}
              </span>
              <button class="btn btn-ghost btn-tiny" type="button" ?disabled=${st.ownerBusy || owners.length <= 1}
                @click=${() => removeOwner(o.user || o.user_name)}>Remove</button>
            </li>`)}</ul>`
          : html`<p class="muted">No owners listed.</p>`}
        ${ownersMissing ? nothing : html`<form class="form owner-add" @submit=${addOwner}>
          <label for="add-owner">Add owner
            <input id="add-owner" type="text" autocomplete="username" placeholder="username"
              pattern="[a-z0-9][a-z0-9-]{2,31}" .value=${st.ownerDraft}
              @input=${(e) => { st.ownerDraft = e.target.value; draw(); }} />
          </label>
          <button class="btn btn-primary" type="submit" ?disabled=${st.ownerBusy || !(st.ownerDraft || '').trim()}>${st.ownerBusy ? 'Working…' : 'Add owner'}</button>
        </form>`}
        ${st.ownerErr ? html`<p class="form-error">${st.ownerErr}</p>` : nothing}
      </section>
      <section class="danger-zone" aria-label="Danger zone">
        <h2>Danger zone</h2>
        <p>This permanently deletes <code>${full}</code>: its listing, branches, pull requests and metadata, and schedules removal of its stored data from Filecoin. This cannot be undone.</p>
        <form class="form" @submit=${deleteRepo}>
          <label for="delete-confirm">Type <code>${full}</code> to confirm</label>
          <input id="delete-confirm" class="confirm-input" type="text" autocomplete="off" spellcheck="false"
            .value=${st.deleteConfirm} @input=${(e) => { st.deleteConfirm = e.target.value; draw(); }} />
          <div class="form-actions">
            <button class="btn btn-danger" type="submit" ?disabled=${!confirmOk || st.deleteBusy}>${st.deleteBusy ? 'Deleting…' : 'Delete repository'}</button>
          </div>
        </form>
        ${st.deleteErr ? html`<p class="form-error">${st.deleteErr}</p>` : nothing}
      </section>
    `;
  };

  const syncTab = () => html`
    <h2 style="margin-top:0">Pull and merge</h2>
    <p><code>scn pull</code> updates the working copy. <code>scn merge &lt;ref&gt;</code> three-way-merges with a target ref. Both-changed paths get git-style markers; push refuses while markers remain.</p>
    ${pre([ENV, `scn clone ${full}`, `cd ${repo}`, 'scn branch new my-feature --from main', 'scn branch switch my-feature', '# edit files; if main moved:', 'scn pull', 'scn merge main'])}
    <p>A conflicted file looks like:</p>
    ${conflictSample()}
    <p>Remove the markers, keep the resolved contents, then:</p>
    ${pre(['scn push -m "merge main"', `scn pr create --title "My change"`, `scn pr merge 1`])}
    <p class="tiny-note"><a href="/#/getting-started">Full getting-started guide</a> · <a href="/#/ci">CI on ScionBase</a></p>`;

  const view = () => {
    if (!st.info) {
      return html`<div class="page"><div class="container"><p class="muted">Loading repository…</p></div></div>`;
    }
    if (isRepoNotFound(st.info)) {
      return html`<div class="page"><div class="container">
        <h1>Repository not found</h1>
        <p>The repository <strong>${full}</strong> does not exist.</p>
        <p><a href=${orgUrl(org)}>View repositories in ${org}</a> · <a href="/#/">Back home</a></p>
      </div></div>`;
    }
    const { parts } = parseLocation();
    const showRepoTabs = parts.length === 2; // only when breadcrumbs end at the repo
    return html`<div class="page"><div class="container">
      ${showRepoTabs ? html`<nav class="repo-tabs" aria-label="Repository">
        <a href=${repoUrl(org, repo)} aria-current=${st.tab === 'code' ? 'page' : nothing}>Code</a>
        <a href=${repoUrl(org, repo, ['issues'])} aria-current=${st.tab === 'issues' ? 'page' : nothing}>Issues</a>
        <a href=${repoUrl(org, repo, ['pulls'])} aria-current=${st.tab === 'pulls' ? 'page' : nothing}>Pull requests</a>
        <a href=${repoUrl(org, repo, ['sync'])} aria-current=${st.tab === 'sync' ? 'page' : nothing}>Sync</a>
        ${isViewerOwner() ? html`<a href=${repoUrl(org, repo, ['settings'])} aria-current=${st.tab === 'settings' ? 'page' : nothing}>Settings</a>` : nothing}
      </nav>` : nothing}
      ${st.tab === 'pulls' ? pullsTab() : st.tab === 'issues' ? issuesTab() : st.tab === 'sync' ? syncTab() : st.tab === 'settings' ? settingsTab() : codeTab()}
    </div></div>`;
  }

  const issuesTab = () => {
    if (st.issueNo) {
      const it = st.issue;
      if (!it) return html`<p class="muted">Loading issue…</p>`;
      if (!it.live) return html`<p class="muted">Could not load #${st.issueNo}: ${it.error}</p>`;
      const d = it.data || {};
      const state = String(d.state || 'open');
      const open = state === 'open';
      const isAuthor = meIsAuthor(d);
      const canEditIssue = isAuthor;
      const canToggle = isAuthor || isViewerOwner();
      const commentsPath = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(st.issueNo)}/comments`;
      const reloadIssueComments = async () => {
        st.issueComments = await tryGet(commentsPath, { comments: [] }, { auth: true });
      };
      const toggle = async () => {
        if (!canToggle || st.issueBusy) return;
        st.issueErr = ''; st.issueBusy = true; draw();
        try {
          const body = { state: open ? 'closed' : 'open' };
          const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(st.issueNo)}`, { method: 'PATCH', auth: true, body });
          st.issue = { live: true, data };
        } catch (e) { st.issueErr = e.message || String(e); }
        st.issueBusy = false; draw();
      };
      const comments = asNamedList(st.issueComments?.data, 'comments');
      const commentsMissing = apiUnavailable(st.issueComments);
      const signedIn = !!getAuth()?.token;
      const submitIssueComment = async (e) => {
        e.preventDefault();
        const body = String(st.issueConvDraft || '').trim();
        if (!body || st.issueConvBusy) return;
        st.issueCommentErr = ''; st.issueConvBusy = true; draw();
        try {
          await api(commentsPath, { method: 'POST', auth: true, body: { body } });
          st.issueConvDraft = '';
          await reloadIssueComments();
          st.issueConvBusy = false; draw();
        } catch (err) {
          st.issueCommentErr = err.message || String(err);
          st.issueConvBusy = false; draw();
        }
      };
      const saveIssueComment = async (e, c) => {
        e.preventDefault();
        if (!c?.id || st.issueCommentEditing?.busy) return;
        const body = String(st.issueCommentEditing.body || '').trim();
        if (!body) return;
        st.issueCommentErr = '';
        st.issueCommentEditing = { ...st.issueCommentEditing, busy: true };
        draw();
        try {
          await api(`${commentsPath}/${encodeURIComponent(c.id)}`, { method: 'PATCH', auth: true, body: { body } });
          st.issueCommentEditing = null;
          await reloadIssueComments();
          draw();
        } catch (err) {
          st.issueCommentErr = err.message || String(err);
          st.issueCommentEditing = { ...st.issueCommentEditing, busy: false };
          draw();
        }
      };
      const deleteIssueComment = async (c) => {
        if (!c?.id) return;
        st.issueCommentErr = '';
        try {
          await api(`${commentsPath}/${encodeURIComponent(c.id)}`, { method: 'DELETE', auth: true });
          await reloadIssueComments();
          draw();
        } catch (err) {
          st.issueCommentErr = err.message || String(err);
          draw();
        }
      };
      const issueCommentBlock = (c) => {
        const mine = commentIsMine(c);
        const editing = st.issueCommentEditing && String(st.issueCommentEditing.id) === String(c.id);
        return html`<div class="pr-comment">
          <div class="pr-comment-meta">
            <strong>${userLink(c.author || c.user || c.author_name)}</strong>
            <span class="tiny-note">${fmtTime(c.created_at)}</span>
            ${mine && c.id && !editing ? html`<button class="btn btn-ghost btn-tiny" type="button" @click=${() => { st.issueCommentEditing = { id: c.id, body: c.body || '', busy: false }; draw(); }}>Edit</button>` : nothing}
            ${mine && c.id ? html`<button class="btn btn-ghost btn-tiny" type="button" @click=${() => deleteIssueComment(c)}>Delete</button>` : nothing}
          </div>
          ${editing ? html`<form class="form" @submit=${(e) => saveIssueComment(e, c)}>
            <textarea rows="4" .value=${st.issueCommentEditing.body} @input=${(e) => { if (st.issueCommentEditing) st.issueCommentEditing.body = e.target.value; }}></textarea>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit" ?disabled=${st.issueCommentEditing.busy}>${st.issueCommentEditing.busy ? 'Saving…' : 'Save'}</button>
              <button class="btn" type="button" @click=${() => { st.issueCommentEditing = null; draw(); }}>Cancel</button>
            </div>
          </form>` : html`<div class="pr-comment-body">${c.body || ''}</div>`}
        </div>`;
      };
      return html`<div class="pr-detail">
        <p><a href=${repoUrl(org, repo, ['issues'])}>← Issues</a></p>
        <div class="card pr-title-box">
          <div class="pr-title-row">
            ${st.issueEditing ? html`
              <form class="form" @submit=${async (e) => {
                e.preventDefault();
                if (!canEditIssue || st.issueEditBusy) return;
                st.issueErr = ''; st.issueEditBusy = true; draw();
                try {
                  const body = {
                    title: String(st.issueEditTitle || '').trim(),
                    body: String(st.issueEditBody || ''),
                  };
                  const tag = String(st.issueEditTag || '').trim();
                  if (tag) body.tag = tag; else body.tag = '';
                  const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(st.issueNo)}`, { method: 'PATCH', auth: true, body });
                  st.issue = { live: true, data };
                  st.issueEditing = false; st.issueEditBusy = false; draw();
                } catch (e3) { st.issueErr = e3.message || String(e3); st.issueEditBusy = false; draw(); }
              }}>
                <label for="is-edit-title">Title</label>
                <input id="is-edit-title" type="text" .value=${st.issueEditTitle} @input=${(e) => { st.issueEditTitle = e.target.value; }} required />
                <label for="is-edit-body">Description</label>
                <textarea id="is-edit-body" rows="6" .value=${st.issueEditBody} @input=${(e) => { st.issueEditBody = e.target.value; }}></textarea>
                <label for="is-edit-tag">Tag</label>
                <input id="is-edit-tag" type="text" placeholder="ui, infra, urgent" .value=${st.issueEditTag || ''} @input=${(e) => { st.issueEditTag = e.target.value; }} />
                <div class="form-actions">
                  <button class="btn btn-primary" type="submit" ?disabled=${st.issueEditBusy}>${st.issueEditBusy ? 'Saving…' : 'Save'}</button>
                  <button class="btn" type="button" @click=${() => { st.issueEditing = false; draw(); }}>Cancel</button>
                </div>
              </form>
            ` : html`
              <h2>#${d.number ?? st.issueNo} ${d.title || ''}</h2>
              ${canEditIssue ? html`<button class="btn" type="button" @click=${() => { st.issueEditing = true; st.issueEditTitle = d.title || ''; st.issueEditBody = d.body || ''; st.issueEditTag = d.tag || ''; draw(); }}>Edit</button>` : nothing}
            `}
          </div>
          <div class="pr-meta-row">
            <span class="badge pr-state">${state}</span>
            <span>${userLink(d.author || d.user || d.author_name)}</span>
            <span class="tiny-note">${fmtTime(d.created_at)}</span>
          </div>
          ${d.tag ? html`<p class="tiny-note">Tag: <strong>${d.tag}</strong></p>` : nothing}
          ${d.body ? html`<div class="md-body">${(() => { const r = renderMarkdown(d.body, { org, repo, ref: st.ref, dir: '' }); return r.template; })()}</div>` : html`<p class="muted">No description.</p>`}
          <div class="pr-actions">
            ${canToggle ? html`<button class="btn" type="button" ?disabled=${st.issueBusy} @click=${toggle}>${st.issueBusy ? 'Working…' : (open ? 'Close' : 'Reopen')}</button>` : nothing}
          </div>
          ${st.issueErr ? html`<p class="form-error">${st.issueErr}</p>` : nothing}
        </div>
        <section class="pr-comments" aria-label="Comments">
          <h3>Comments</h3>
          ${!st.issueComments ? html`<p class="muted">Loading comments…</p>`
            : commentsMissing ? html`<p class="muted">Comments are not available on this API yet.</p>`
            : comments.length ? comments.map(issueCommentBlock)
              : html`<p class="muted">No comments yet.</p>`}
          ${commentsMissing ? nothing : signedIn ? html`<form class="card form pr-add-comment" @submit=${submitIssueComment}>
            <label for="is-conv-body">Add comment</label>
            <textarea id="is-conv-body" rows="4" @input=${(e) => { st.issueConvDraft = e.target.value; }} .value=${st.issueConvDraft}></textarea>
            <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.issueConvBusy || !(st.issueConvDraft || '').trim()}>${st.issueConvBusy ? 'Posting…' : 'Comment'}</button></div>
          </form>` : html`<p class="tiny-note"><a href=${`/#/login?next=${encodeURIComponent(location.pathname + location.hash)}`}>Sign in to comment</a></p>`}
          ${st.issueCommentErr ? html`<p class="form-error">${st.issueCommentErr}</p>` : nothing}
        </section>
      </div>`;
    }
    const list = Array.isArray(st.issues?.data) ? st.issues?.data : st.issues?.data?.issues || [];
    const f = st.issueDraft;
    const submit = async (e) => {
      e.preventDefault();
      if (f.busy) return;
      f.err = ''; f.busy = true; draw();
      try {
        const payload = { title: String(f.title || '').trim(), body: String(f.body || '') };
        const tag = String(f.tag || '').trim();
        if (tag) payload.tag = tag;
        if (!payload.title) throw new Error('title is required');
        const data = await api(`/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues`, { method: 'POST', auth: true, body: payload });
        const num = data?.number || data?.id;
        if (!num) throw new Error('issue create did not return a number');
        navigate(repoUrl(org, repo, ['issues', String(num)]));
      } catch (e2) { f.err = e2.message || String(e2); f.busy = false; draw(); }
    };
    const currentTag = parseLocation().query.get('tag') || '';
    const onFilter = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const t = String(fd.get('tag') || '').trim();
      const base = repoUrl(org, repo, ['issues']);
      navigate(t ? `${base}?tag=${encodeURIComponent(t)}` : base);
    };
    return html`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
        <h2 style="margin:.2rem 0">Open issues</h2>
        <form class="form" style="display:flex;align-items:center;gap:.4rem;margin:.2rem 0" @submit=${onFilter}>
          <input name="tag" type="text" placeholder="Filter by tag" .value=${currentTag} />
          <button class="btn" type="submit">Apply</button>
        </form>
      </div>
      ${!st.issues ? html`<p class="muted">Loading…</p>`
        : st.issues.live === false && (st.issues.status === 404 || st.issues.status === 405) ? html`<p class="muted">Issues are not available on this API yet.</p>`
        : list.length ? html`<ul class="repo-list">${list
            .filter((i) => (i.state || 'open') === 'open')
            .map((i) => html`<li class="repo-item">
            <a href=${repoUrl(org, repo, ['issues', String(i.number)])}><strong>#${i.number}</strong> ${i.title}</a>
            <span class="badge">${i.state || 'open'}</span>
            ${i.tag ? html`<span class="tiny-note" style="margin-left:.25rem">tag: <strong>${i.tag}</strong></span>` : nothing}
          </li>`)}</ul>` : html`<p class="muted">No open issues.</p>`}
      ${getAuth()?.token ? html`<form class="card form" style="margin-top:1rem" @submit=${submit}>
        <h3 style="margin:.2rem 0">New issue</h3>
        <label for="is-title">Title</label>
        <input id="is-title" type="text" .value=${f.title} @input=${(e) => { f.title = e.target.value; }} required />
        <label for="is-body">Description</label>
        <textarea id="is-body" rows="6" .value=${f.body} @input=${(e) => { f.body = e.target.value; }}></textarea>
        <label for="is-tag">Tag <span class="tiny-note">optional</span></label>
        <input id="is-tag" type="text" placeholder="ui, infra, urgent" .value=${f.tag || ''} @input=${(e) => { f.tag = e.target.value; }} />
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" ?disabled=${f.busy}>${f.busy ? 'Creating…' : 'Create issue'}</button>
        </div>
        ${f.err ? html`<p class="form-error">${f.err}</p>` : nothing}
      </form>` : html`<p class="tiny-note" style="margin-top:1rem"><a href="/#/login">Sign in</a> to create an issue.</p>`}
    `;
  };

  return {
    view,
    load: async (rerender) => {
      const b = `/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
      const authed = !!getAuth()?.token;
      // Never invent repo metadata on 404. A missing repo must not look real
      // and then fail later with a confusing "ref … not found" tree error.
      const info = await tryGet(b, null, { auth: authed });
      st.info = info;
      rerender();
      if (isRepoNotFound(info)) return;
      tryGet(`${b}/owners`, { owners: [] }, { auth: authed }).then((s) => { st.owners = s; rerender(); });
      if (authed) refreshMe();
      tryGet(`${b}/branches`, { branches: [{ name: 'main', target: '' }] }).then((s) => {
        if (s.live && !s.data.branches) s.data = { branches: s.data };
        st.branches = s;
        rerender();
      });
      if (st.tab === 'pulls') {
        if (getAuth()?.token) {
          refreshMe();
          api(`/v1/orgs/${encodeURIComponent(org)}/membership`, { auth: true })
            .then((m) => { st.membership = m; rerender(); })
            .catch(() => {});
        }
        if (st.pullNo && st.pullNo !== 'new') {
          tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}`, null).then(async (s) => {
            st.pull = s;
            rerender();
            if (!s?.live || !s.data) return;
            const d = s.data;
            Promise.all([
              tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}/comments`, { comments: [] }, { auth: true }),
              tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}/approvals`, { approvals: [] }, { auth: true }),
              tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}/mergeability`, null, { auth: true }),
              tryGet(`${b}/pulls/${encodeURIComponent(st.pullNo)}/reviews`, { reviews: [] }, { auth: true }).catch(() => ({ live: false, status: 404, data: { reviews: [] } })),
            ]).then(([c, a, m, r]) => {
              st.comments = c;
              st.approvals = a;
              st.mergeability = m;
              st.reviews = r;
              rerender();
            });
            loadChecks();
            if (st.prTab !== 'files') return;
            try {
              const cmp = await loadPullFileList(org, repo, st.pullNo, d);
              st.diff = { files: cmp.files || [], source: cmp.source, base: cmp.base, head: cmp.head };
              rerender();
              const baseRev = cmp.base || d.base_target || d.base_ref || d.base || 'main';
              const headRev = cmp.head || d.head_target || d.head_ref || d.head;
              const loaded = await loadFileDiffs(org, repo, baseRev, headRev, cmp.files || []);
              st.diff = { ...st.diff, ...loaded };
              rerender();
              await highlightDiffRows(st.diff.rows || []);
            } catch (e) {
              st.diff = { files: [], error: e.message || String(e) };
            }
            rerender();
          });
        } else {
          tryGet(`${b}/pulls`, { pulls: [] }).then((s) => { st.pulls = s; rerender(); });
        }
        return;
      }
      if (st.tab === 'issues') {
        if (authed) refreshMe();
        if (st.issueNo) {
          tryGet(`${b}/issues/${encodeURIComponent(st.issueNo)}`, null, { auth: authed }).then((s) => { st.issue = s; rerender(); });
          tryGet(`${b}/issues/${encodeURIComponent(st.issueNo)}/comments`, { comments: [] }, { auth: authed }).then((s) => { st.issueComments = s; rerender(); });
        } else {
          const t = parseLocation().query.get('tag') || '';
          const path = t ? `${b}/issues?tag=${encodeURIComponent(t)}` : `${b}/issues`;
          tryGet(path, { issues: [] }, { auth: authed }).then((s) => { st.issues = s; rerender(); });
        }
        return;
      }
      if (st.tab === 'settings') return;
      if (st.tab !== 'code') return;
      loadCommits(org, repo, st.ref).then((c) => { st.commits = c; rerender(); }).catch(() => {});
      if (st.kind === 'blob' && st.path) {
        loadBlob(org, repo, st.ref, st.path, { entries: st.tree?.entries }).then(async (blob) => {
          const name = st.path.split('/').pop() || '';
          if (blob.bytes && isLikelyText(blob.bytes, name) && isMarkdownName(name)) {
            const text = decodeUtf8(blob.bytes);
            const dir = parentDir(st.path);
            const rendered = renderMarkdown(text, { org, repo, ref: st.ref, dir });
            blob.mdTemplate = rendered.template;
            blob.mdImages = rendered.images;
            st.blob = blob;
            rerender();
            if (rendered.images.length) {
              await hydrateReadmeImages(rendered.images, org, repo, st.ref);
              blob.mdTemplate = renderMarkdown(text, { org, repo, ref: st.ref, dir }, rendered.images).template;
            }
          }
          st.blob = blob;
          rerender();
        }).catch((e) => {
          const msg = friendlyFileError(e);
          st.blob = { bytes: null, loc: {}, error: e.message, loadError: msg, spError: isRefNotFoundMessage(e.message) ? '' : e.message };
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
            const blob = await loadBlob(org, repo, st.ref, rpath, { entry: readmeEnt });
            const text = blob.bytes && isLikelyText(blob.bytes, readmeEnt.name) ? decodeUtf8(blob.bytes) : '';
            const md = isMarkdownName(readmeEnt.name);
            let template = null;
            let images = [];
            if (md && text) {
              const rendered = renderMarkdown(text, { org, repo, ref: st.ref, dir: st.path });
              template = rendered.template;
              images = rendered.images;
            }
            st.readme = { name: readmeEnt.name, bytes: blob.bytes, loc: blob.loc, template, images };
            rerender();
            if (images.length) {
              await hydrateReadmeImages(images, org, repo, st.ref);
              st.readme.template = renderMarkdown(text, { org, repo, ref: st.ref, dir: st.path }, images).template;
            }
          } catch {
            if (!st.readme?.bytes) st.readme = null;
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

/* ---------- syntax highlighting (lazy highlight.js) ---------- */
const HL_BASE = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0';
const EXT_LANG = { go: 'go', rs: 'rust', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash',
  zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', svg: 'xml', css: 'css',
  scss: 'scss', sql: 'sql', proto: 'protobuf', sol: 'javascript', swift: 'swift', php: 'php', lua: 'lua', makefile: 'makefile', mk: 'makefile', dockerfile: 'dockerfile', diff: 'diff' };
function langFor(path) {
  const name = (path.split('/').pop() || '').toLowerCase();
  if (name === 'makefile') return 'makefile';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'go.mod' || name === 'go.sum') return null;
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_LANG[ext] || null;
}
let hljsPromise = null;
function loadHljs() {
  if (!hljsPromise) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${HL_BASE}/styles/github-dark.min.css`;
    document.head.appendChild(link);
    hljsPromise = import(`${HL_BASE}/es/highlight.min.js`).then((m) => m.default || m);
  }
  return hljsPromise;
}
const hlCache = new Map();
function codeBlock(path, text, count) {
  const lang = langFor(path);
  const key = `${path}\u0000${text.length}`;
  const cached = hlCache.get(key);
  if (lang && !cached) {
    hlCache.set(key, { pending: true });
    loadHljs().then((hljs) => {
      try {
        const out = hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : null;
        hlCache.set(key, { html: out });
      } catch { hlCache.set(key, { html: null }); }
      draw();
    }).catch(() => { hlCache.set(key, { html: null }); draw(); });
  }
  const nums = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  const body = cached?.html != null ? unsafeHTML(cached.html) : text;
  return html`<div class="code-wrap"><pre class="ln-col" aria-hidden="true">${nums}</pre><pre class="code-col"><code class=${`hljs${lang ? ` language-${lang}` : ''}`}>${body}</code></pre></div>`;
}

/* ---------- orgs list ---------- */
const OrgsView = () => {
  const st = { orgs: null, err: '', formErr: '', busy: false, created: null };
  async function onCreate(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    st.formErr = ''; st.busy = true; draw();
    try {
      if (!ORG_NAME_RE.test(name)) throw new Error('name must match ^[a-z0-9][a-z0-9-]{2,31}$');
      const data = await api('/v1/orgs', { method: 'POST', auth: true, body: { name } });
      const id = data?.id || data?.name || data?.org || name;
      st.created = id;
      st.busy = false;
      refreshMe();
      navigate(orgUrl(id));
    } catch (err) { st.formErr = err.message || String(err); st.busy = false; draw(); }
  }
  return {
    view: () => html`<div class="page"><div class="container">
      <h1>Organizations</h1>
      ${getAuth() ? html`<form class="card form" style="max-width:28rem;margin:0 0 1.25rem" @submit=${onCreate}>
        <h2 style="margin-top:0">New organization</h2>
        <label for="org-name">Name</label>
        <input id="org-name" name="name" type="text" required pattern="[a-z0-9][a-z0-9-]{2,31}" placeholder="my-org" />
        <div class="form-actions"><button class="btn btn-primary" type="submit" ?disabled=${st.busy}>${st.busy ? 'Creating…' : 'Create organization'}</button></div>
        ${st.formErr ? html`<p class="form-error">${st.formErr}</p>` : nothing}
      </form>` : html`<p class="tiny-note"><a href="/#/login">Sign in</a> to create an organization.</p>`}
      <ul class="repo-list">${!st.orgs ? html`<li class="repo-item"><span class="muted">${st.err || 'Loading…'}</span></li>`
        : st.orgs.length ? st.orgs.map((o) => html`<li class="repo-item"><a href=${orgUrl(o)}><strong>${o}</strong></a></li>`)
        : html`<li class="repo-item"><span class="muted">No organizations yet.</span></li>`}</ul>
      <p class="tiny-note">Your username is your first org. CLI: <code>scn org create &lt;name&gt;</code> · <code>scn org list</code>. <a href="/#/new">New repository</a></p>
    </div></div>`,
    load: async (rerender) => {
      // GET /v1/orgs is the formal orgs table (today: filecoin-project), not
      // username namespaces. The Worker adds { id: actor.name, role: "admin" }
      // on GET /v1/me, so a signed-in list must union /v1/me.orgs and always
      // include the caller's username.
      const names = [];
      const seen = new Set();
      const add = (id) => {
        const n = String(id || '').trim();
        if (!n || seen.has(n)) return;
        seen.add(n);
        names.push(n);
      };
      const fromList = (list) => {
        for (const o of list || []) add(typeof o === 'string' ? o : o?.id || o?.name);
      };
      if (getAuth()?.token) {
        let me = getMe();
        if (!me) me = await refreshMe();
        add(meName() || getAuth()?.username);
        fromList(me?.orgs);
      }
      try {
        const d = await api('/v1/orgs');
        fromList(Array.isArray(d) ? d : d?.orgs || []);
        st.err = '';
      } catch (e) {
        if (!names.length) {
          st.err = `Could not load organizations (${e.message}).`;
          st.orgs = null;
          rerender();
          return;
        }
      }
      st.orgs = names;
      rerender();
    },
  };
};

/* ---------- top bar: breadcrumb + home-only marketing nav ---------- */
function drawChrome() {
  let { parts } = parseLocation();
  const isHome = parts.length === 0;
  document.body.classList.toggle('is-home', isHome);
  const mk = document.getElementById('marketing-nav');
  if (mk) {
    render(isHome ? html`<li><a href="/#problem">Why</a></li><li><a href="/#start">Get started</a></li><li><a href="/#download">Download CLI</a></li><li><a href="/#pricing">Pricing</a></li><li><a href="/#/ci">CI</a></li>` : nothing, mk);
  }
  const el = document.getElementById('crumbs');
  if (!el) return;
  const items = [];
  const sep = () => html`<span class="sep">/</span>`;
  if (parts[0] === 'orgs' && parts.length > 1) {
    items.push(html`<a href="/#/orgs">orgs</a>`);
    items.push(sep());
    parts = parts.slice(1);
  }
  if (parts[0] === 'u') {
    items.push(html`<span>u</span>`);
    if (parts[1]) {
      items.push(sep());
      items.push(html`<a href=${userUrl(parts[1])}>${parts[1]}</a>`);
    }
  } else if (parts[0] === 'orgs' || parts[0] === 'login' || parts[0] === 'new' || parts[0] === 'getting-started' || parts[0] === 'cli' || parts[0] === 'ci' || parts[0] === 'boards') {
    const label = { orgs: 'orgs', login: 'sign in', new: 'new repository', 'getting-started': 'getting started', cli: 'download CLI', ci: 'CI', boards: 'boards' }[parts[0]];
    items.push(html`<span>${label}</span>`);
  } else if (parts.length >= 1) {
    const [org, repo, kind, ref, ...rest] = parts;
    if (repo === 'boards') {
      items.push(html`<a href=${orgUrl(org)}>${org}</a>`);
      items.push(sep());
      items.push(html`<a href=${boardsUrl(org)}>boards</a>`);
      if (kind) { items.push(sep()); items.push(html`<span>${kind}</span>`); }
    } else {
    items.push(html`<a href=${orgUrl(org)}>${org}</a>`);
    if (repo) { items.push(sep()); items.push(html`<a href=${repoUrl(org, repo)}><strong>${repo}</strong></a>`); }
    if (repo && kind === 'pulls') {
      items.push(sep());
      items.push(html`<a href=${repoUrl(org, repo, ['pulls'])}>pulls</a>`);
      if (ref) {
        items.push(sep());
        const isNum = /^\d+$/.test(ref || '');
        items.push(html`<a href=${repoUrl(org, repo, ['pulls', ref])}>${isNum ? `#${ref}` : ref}</a>`);
        if (rest[0] === 'files' || rest[0] === 'conversation') {
          items.push(sep());
          items.push(html`<span>${rest[0]}</span>`);
        }
      }
    }
    if (repo && kind === 'sync') { items.push(sep()); items.push(html`<span>sync</span>`); }
    if (repo && kind === 'settings') { items.push(sep()); items.push(html`<span>settings</span>`); }
    if (repo && (kind === 'tree' || kind === 'blob')) {
      if (ref && ref !== 'main') { items.push(html`<span class="ref-chip">${ref}</span>`); }
      rest.forEach((seg, i) => {
        const sub = rest.slice(0, i + 1).join('/');
        const last = i === rest.length - 1;
        items.push(sep());
        items.push(last && kind === 'blob' ? html`<span>${seg}</span>` : html`<a href=${treeUrl(org, repo, ref || 'main', sub)}>${seg}</a>`);
      });
    }
    }
  }
  render(items.length ? html`<span class="sep">/</span>${items}` : nothing, el);
}

const NotFound = () => html`<div class="page"><div class="container"><h1>Not found</h1><p><a href="/">Back home</a></p></div></div>`;

/* ---------- router ---------- */
const main = document.getElementById('main');
let current = null;
let lastKey = '';

function draw() {
  drawChrome();
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
  if (parts.length === 0) return { view: Home, title: 'ScionBase' };
  if (parts.length === 1 && parts[0] === 'getting-started') return { view: GettingStarted, title: 'Getting started — ScionBase' };
  if ((parts.length === 1 && parts[0] === 'ci') || (parts[0] === 'docs' && parts[1] === 'ci')) return { view: CiDocs, title: 'CI on ScionBase' };
  if (parts.length === 1 && parts[0] === 'cli') return { view: CliView, title: 'Download the CLI — ScionBase' };
  // Boards discovery (org-owned boards live under /#/orgs/:org/boards)
  if (parts.length >= 1 && parts[0] === 'boards') {
    return Object.assign(BoardsView(), { title: 'Boards — ScionBase' });
  }
  // Verified products page
  if (parts.length === 1 && (parts[0] === 'verified-products' || parts[0] === 'filecoin-verified-products')) {
    return { view: VerifiedProducts, title: 'Filecoin Verified Products — ScionBase' };
  }
  if (parts[0] === 'orgs') {
    if (parts.length === 1) return Object.assign(OrgsView(), { title: 'Organizations — ScionBase' });
    if (parts[2] === 'boards') {
      const org = parts[1];
      const id = parts[3] || null;
      return id
        ? Object.assign(BoardView(org, id), { title: `${org} / ${id} — ScionBase` })
        : Object.assign(OrgBoardsView(org), { title: `${org} boards — ScionBase` });
    }
    // /#/orgs/:orgName → same as /#/:orgName (do not treat "orgs" as the org).
    return routeFromParts(parts.slice(1));
  }
  if (parts[0] === 'u') {
    const name = parts[1] || '';
    if (!name) {
      return {
        title: 'Account — ScionBase',
        view: () => getAuth()
          ? html`<div class="page"><div class="container"><p class="muted">Loading account…</p></div></div>`
          : html`<div class="page"><div class="container"><h1>Account</h1><p class="tiny-note"><a href="/#/login">Sign in</a> to view your profile and settings.</p></div></div>`,
        load: async () => {
          const self = meName() || getAuth()?.username;
          if (self) navigate(userUrl(self));
        },
      };
    }
    return Object.assign(UserView(name), { title: `${name} — ScionBase` });
  }
  if (parts.length === 1 && parts[0] === 'login') return LoginView();
  if (parts.length === 1 && parts[0] === 'new') return NewRepoView();
  if (parts.length === 1) {
    const v = OrgView(parts[0]);
    v.title = `${parts[0]} — ScionBase`;
    return v;
  }
  const org = parts[0];
  const repo = parts[1];
  const title = `${org}/${repo} — ScionBase`;
  if (parts.length === 2) return Object.assign(RepoView(org, repo, { tab: 'code', kind: 'tree', ref: 'main', path: '' }), { title });
  const third = parts[2];
  if (third === 'pulls') {
    const n = parts[3] === 'new' ? 'new' : (parts[3] && /^\d+$/.test(parts[3]) ? parts[3] : null);
    const prTab = n && parts[4] === 'files' ? 'files' : 'conversation';
    const t = n && n !== 'new' ? `${org}/${repo} #${n} — ScionBase` : title;
    return Object.assign(RepoView(org, repo, { tab: 'pulls', pull: n, prTab }), { title: t });
  }
  if (third === 'issues') {
    const n = parts[3] && /^\d+$/.test(parts[3]) ? parts[3] : null;
    const t = n ? `${org}/${repo} #${n} — ScionBase` : title;
    return Object.assign(RepoView(org, repo, { tab: 'issues', issue: n }), { title: t });
  }
  if (third === 'sync') {
    return Object.assign(RepoView(org, repo, { tab: 'sync' }), { title });
  }
  if (third === 'settings') {
    return Object.assign(RepoView(org, repo, { tab: 'settings' }), { title: `${org}/${repo} settings — ScionBase` });
  }
  if (third === 'tree' || third === 'blob') {
    const ref = parts[3] || 'main';
    const path = parts.slice(4).join('/');
    return Object.assign(RepoView(org, repo, { tab: 'code', kind: third, ref, path }), { title });
  }
  return { view: NotFound, title: 'Not found — ScionBase' };
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
    ? html`<a class="btn btn-primary" href="/#/new">New</a><a class="nav-user" href=${userUrl(meName() || a.username)}>${meName() || a.username}</a><button class="btn btn-ghost" type="button" @click=${() => { setAuth(null); if (location.hash.startsWith('#/new') || location.hash.startsWith('#/login') || location.hash.startsWith('#/u/')) navigate('/#/'); else draw(); }}>Log out</button>`
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
    parts[0] === 'login' ? 'Sign in — ScionBase'
      : parts[0] === 'new' ? 'New repository — ScionBase'
        : 'ScionBase'
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
if (getAuth()?.token) refreshMe();
route();
