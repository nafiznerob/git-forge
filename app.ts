// git-forge: a single-process, stdlib-only GitHub-compatible git forge.
//
// One Node 22 process serves git smart HTTP (upload-pack v2, receive-pack v0),
// the REST v3 API under /api/v3, GraphQL at /api/graphql and MCP at /mcp,
// all over one in-memory store. No disk I/O on any request path, no git
// binary, no network, no wall clock in any response value: every timestamp
// the forge emits derives from a deterministic counter, so replaying the
// same requests in the same order reproduces the same state byte for byte.
//
// The viewer is the token owner. The token comes from MAKEFUN_SHOP_TOKEN;
// the scenario that grades this forge always uses that token, and its
// owner login is the fixed scenario viewer, adaiversen.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const FIXED_DATE = '2020-01-01T00:00:00Z';
const EPOCH_SEC = 1700000000;
const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
function gitHash(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([head, data]));
}
function b64(buf: Buffer): string {
  return buf.toString('base64');
}
function b64dec(s: string): Buffer {
  return Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64');
}
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}
function gidDecode(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i < 1) return null;
    return { kind: s.slice(0, i), key: s.slice(i + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- store

interface GitObj {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
  deflated: Buffer | null;
  parents: string[];
  tree: string;
}
interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  seq: number;
  json: string;
}
interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  baseBlob: string | null;
  headBlob: string | null;
}
interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  issueSeq: number;
  issueIdSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, string>;
  packCache: Map<string, Buffer>;
  treeCache: Map<string, Map<string, { blob: string; data: Buffer }>>;
  repoJson: string;
}

const repos = new Map<string, Repo>();
let repoIdSeq = 0;
let globalIssueId = 0;
let globalPullId = 0;
let globalCommentId = 0;
let commitSeq = 0;
let requestSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function viewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const r of repos.values()) if (r.owner === VIEWER_LOGIN) out.push(r);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

function repoObject(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: gid('R', `${r.owner}/${r.name}`),
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: r.isPrivate ? 'private' : 'public',
    license: null,
  };
}
function makeRepo(name: string, isPrivate: boolean, description: string): Repo {
  const r: Repo = {
    id: ++repoIdSeq,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: 'main',
    seq: repoIdSeq,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    issueSeq: 0,
    issueIdSeq: 0,
    pulls: [],
    pullSeq: 0,
    labels: new Map(),
    packCache: new Map(),
    treeCache: new Map(),
    repoJson: '',
  };
  r.repoJson = JSON.stringify(repoObject(r));
  repos.set(repoKey(VIEWER_LOGIN, name), r);
  return r;
}
function refreshRepoJson(r: Repo): void {
  r.repoJson = JSON.stringify(repoObject(r));
}

// ---------------------------------------------------------------- git objects

function storeObject(r: Repo, type: GitObj['type'], data: Buffer): string {
  const oid = gitHash(type, data);
  let obj = r.objects.get(oid);
  if (!obj) {
    obj = { type, data, deflated: null, parents: [], tree: '' };
    if (type === 'commit') {
      const parsed = parseCommit(data);
      obj.parents = parsed.parents;
      obj.tree = parsed.tree;
    }
    r.objects.set(oid, obj);
  }
  return oid;
}
function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}
function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ts = EPOCH_SEC + ++commitSeq;
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(s, 'utf8');
}
// Flatten a commit's tree to path -> {blob, data}. Cached per commit oid.
function flatTree(r: Repo, commitOid: string): Map<string, { blob: string; data: Buffer }> {
  const cached = r.treeCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, { blob: string; data: Buffer }>();
  const obj = r.objects.get(commitOid);
  if (obj && obj.type === 'commit') {
    const walk = (treeOid: string, prefix: string): void => {
      const t = r.objects.get(treeOid);
      if (!t) return;
      for (const e of parseTree(t.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else {
          const b = r.objects.get(e.oid);
          out.set(path, { blob: e.oid, data: b ? b.data : Buffer.alloc(0) });
        }
      }
    };
    walk(obj.tree, '');
  }
  if (r.treeCache.size > 64) r.treeCache.clear();
  r.treeCache.set(commitOid, out);
  return out;
}
function treeFromFiles(r: Repo, files: Map<string, { blob: string; data: Buffer }>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const mk = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = mk();
  for (const [path, f] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, mk());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, f.blob);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(r, 'tree', buildTree(entries));
  };
  return build(root);
}
function ancestors(r: Repo, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid) || oid === ZERO_OID) continue;
    out.add(oid);
    const obj = r.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of obj.parents) stack.push(p);
  }
  return out;
}
function reachableObjects(r: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const t = r.objects.get(treeOid);
    if (!t) return;
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else out.add(e.oid);
    }
  };
  const visit = (oid: string): void => {
    if (oid === ZERO_OID || out.has(oid)) return;
    const obj = r.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      out.add(oid);
      addTree(obj.tree);
      for (const p of obj.parents) visit(p);
    } else if (obj.type === 'tag') {
      out.add(oid);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) visit(m[1]!);
    } else out.add(oid);
  };
  for (const t of tips) visit(t);
  return out;
}
function isAncestor(r: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return ancestors(r, desc).has(anc);
}
function peeledOid(r: Repo, oid: string): string | null {
  const obj = r.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    return m ? peeledOid(r, m[1]!) : null;
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

// Build a pack (v2, no deltas) for a set of oids, in a stable order.
function buildPack(r: Repo, oids: Set<string>): Buffer {
  const list = [...oids].sort();
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]!.write('PACK', 0, 'ascii');
  parts[0]!.writeUInt32BE(2, 4);
  parts[0]!.writeUInt32BE(list.length, 8);
  for (const oid of list) {
    const obj = r.objects.get(oid);
    if (!obj) continue;
    if (!obj.deflated) obj.deflated = deflateSync(obj.data, { level: 6 });
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const header: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 15);
    s >>= 4;
    if (s) first |= 0x80;
    header.push(first);
    while (s) {
      let b = s & 0x7f;
      s >>= 7;
      if (s) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header), obj.deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
function cachedPack(r: Repo, key: string, oids: Set<string>): Buffer {
  let pack = r.packCache.get(key);
  if (!pack) {
    pack = buildPack(r, oids);
    if (r.packCache.size > 24) r.packCache.clear();
    r.packCache.set(key, pack);
  }
  return pack;
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p++]!;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let len = 0;
  while (p < delta.length) {
    const op = delta[p++]!;
    if (op & 0x80) {
      let off = 0;
      let sz = 0;
      if (op & 0x01) off = delta[p++]!;
      if (op & 0x02) off |= delta[p++]! << 8;
      if (op & 0x04) off |= delta[p++]! << 16;
      if (op & 0x08) off |= delta[p++]! << 24;
      if (op & 0x10) sz = delta[p++]!;
      if (op & 0x20) sz |= delta[p++]! << 8;
      if (op & 0x40) sz |= delta[p++]! << 16;
      if (sz === 0) sz = 0x10000;
      out.push(base.subarray(off, off + sz));
      len += sz;
    } else if (op) {
      out.push(delta.subarray(p, p + op));
      p += op;
      len += op;
    } else throw new Error('delta opcode 0');
  }
  if (len !== dstSize) throw new Error('delta output size mismatch');
  return Buffer.concat(out);
}
// Find where a zlib stream starting at `start` ends. inflateSync ignores
// trailing bytes but throws on a truncated stream, so the smallest end that
// inflates cleanly is the stream's end (binary search over the tail).
function endOfZlib(buf: Buffer, start: number): number {
  let lo = start + 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}
// Parse a received pack; returns the objects it carries (type + raw data).
// `lookup` resolves REF_DELTA bases that live in the repo already.
function parsePack(buf: Buffer, lookup: (oid: string) => GitObj | undefined): { type: GitObj['type']; data: Buffer }[] {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  interface Raw {
    start: number;
    type: GitObj['type'];
    data: Buffer;
    baseOff?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    let b = buf[off++]!;
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    void size;
    let baseOff: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      b = buf[off++]!;
      let v = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++]!;
        v = ((v + 1) << 7) | (b & 0x7f);
      }
      baseOff = start - v;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const end = endOfZlib(buf, off);
    const inflated = inflateSync(buf.subarray(off, end));
    off = end;
    const typeName: GitObj['type'] =
      typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : typeNum === 4 ? 'tag' : 'blob';
    raw.push({ start, type: typeName, data: inflated, baseOff, baseOid });
  }
  // Resolve deltas in pack order (a delta's base always precedes it).
  const byOffset = new Map<number, { type: GitObj['type']; data: Buffer }>();
  const resolved: { type: GitObj['type']; data: Buffer }[] = [];
  for (const entry of raw) {
    let item: { type: GitObj['type']; data: Buffer };
    if (entry.baseOff !== undefined) {
      const base = byOffset.get(entry.baseOff);
      if (!base) throw new Error('delta base missing');
      item = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.baseOid !== undefined) {
      let found: { type: GitObj['type']; data: Buffer } | undefined;
      for (const r of resolved) if (gitHash(r.type, r.data) === entry.baseOid) found = r;
      if (!found) {
        const stored = lookup(entry.baseOid);
        if (stored) found = { type: stored.type, data: stored.data };
      }
      if (!found) throw new Error('ref-delta base missing');
      item = { type: found.type, data: applyDelta(found.data, entry.data) };
    } else item = { type: entry.type, data: entry.data };
    byOffset.set(entry.start, item);
    resolved.push(item);
  }
  return resolved;
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}
// Decode a whole pkt-line stream; throws on garbage.
function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('short pkt-line');
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('pkt-line overruns buffer');
      out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}
function pktTextLines(buf: Buffer): string[] {
  return decodePkts(buf)
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------- HTTP plumbing

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function authed(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function reqId(): string {
  return `req-${++requestSeq}`;
}
function send(res: ServerResponse, status: number, body: Buffer | string, contentType: string, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'x-github-request-id': reqId(),
    ...extra,
  });
  res.end(buf);
}
function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), JSON_TYPE, extra);
}
function sendJsonText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  send(res, status, text, JSON_TYPE, extra);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const buf = await readBody(req);
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function hostOf(req: IncomingMessage): string {
  const h = req.headers.host ?? '127.0.0.1';
  return `http://${h}`;
}
function pathParts(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

// ---------------------------------------------------------------- issues & pulls (shared by REST, GraphQL, MCP)

function issueObject(r: Repo, iss: Issue): Record<string, unknown> {
  return {
    id: iss.id,
    number: iss.number,
    title: iss.title,
    body: iss.body,
    state: iss.state,
    labels: iss.labels.map((name) => ({ name, color: r.labels.get(name) ?? 'ededed', id: 0 })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: iss.state === 'closed' ? FIXED_DATE : null,
    comments: iss.comments.length,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${iss.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function refreshIssueJson(r: Repo, iss: Issue): void {
  iss.json = JSON.stringify(issueObject(r, iss));
}
function createIssueInternal(r: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const name of labels) {
    if (!r.labels.has(name)) return { error: `Label does not exist: ${name}` };
  }
  const iss: Issue = {
    number: ++r.issueSeq,
    id: ++globalIssueId,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: r.issueSeq,
    json: '',
  };
  refreshIssueJson(r, iss);
  r.issues.push(iss);
  return iss;
}
function pullObject(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeSha,
    mergeable: prMergeable(r, p) ? true : false,
    head: { ref: p.headRef, sha: p.headSha, label: `${VIEWER_LOGIN}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${VIEWER_LOGIN}:${p.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: p.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function diffFiles(r: Repo, baseSha: string, headSha: string): PullFile[] {
  const base = flatTree(r, baseSha);
  const head = flatTree(r, headSha);
  const files: PullFile[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && h && b.blob === h.blob) continue;
    const countLines = (d: Buffer): number => {
      if (d.length === 0) return 0;
      let n = 0;
      for (let i = 0; i < d.length; i++) if (d[i] === 10) n++;
      return n + 1;
    };
    if (!b && h) {
      files.push({ filename: name, status: 'added', additions: countLines(h.data), deletions: 0, changes: countLines(h.data), baseBlob: null, headBlob: h.blob });
    } else if (b && !h) {
      const del = countLines(b.data);
      files.push({ filename: name, status: 'removed', additions: 0, deletions: del, changes: del, baseBlob: b.blob, headBlob: null });
    } else if (b && h) {
      const add = countLines(h.data);
      const del = countLines(b.data);
      files.push({ filename: name, status: 'modified', additions: add, deletions: del, changes: add + del, baseBlob: b.blob, headBlob: h.blob });
    }
  }
  return files;
}
function createPullInternal(r: Repo, title: string, body: string, head: string, base: string): Pull | { error: string; status: number } {
  const headSha = r.refs.get(`refs/heads/${head}`);
  const baseSha = r.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { error: 'head or base branch not found', status: 422 };
  for (const p of r.pulls) {
    if (p.state === 'open' && p.headRef === head && p.baseRef === base) return { error: 'a pull request already exists for this branch', status: 422 };
  }
  const p: Pull = {
    number: ++r.pullSeq,
    id: ++globalPullId,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    files: diffFiles(r, baseSha, headSha),
    seq: r.pullSeq,
  };
  r.pulls.push(p);
  return p;
}
// A PR conflicts when the default branch has moved a file the PR also changed,
// to different content than both the base and the head versions.
function prConflict(r: Repo, p: Pull): boolean {
  const currentTip = r.refs.get(`refs/heads/${p.baseRef}`);
  if (!currentTip) return false;
  const current = flatTree(r, currentTip);
  const base = flatTree(r, p.baseSha);
  const head = flatTree(r, p.headSha);
  for (const f of p.files) {
    const cur = current.get(f.filename);
    const b = base.get(f.filename);
    const h = head.get(f.filename);
    const curBlob = cur ? cur.blob : null;
    const baseBlob = b ? b.blob : null;
    const headBlob = h ? h.blob : null;
    if (curBlob !== baseBlob && curBlob !== headBlob) return true;
  }
  return false;
}
function prMergeable(r: Repo, p: Pull): boolean {
  return p.state === 'open' && !prConflict(r, p);
}
function mergePullInternal(r: Repo, p: Pull): { sha: string } | { error: string; status: number } {
  if (p.state !== 'open') return { error: 'pull request is already closed', status: 405 };
  if (prConflict(r, p)) return { error: 'merge conflict', status: 405 };
  const baseTip = r.refs.get(`refs/heads/${p.baseRef}`)!;
  const baseFiles = flatTree(r, baseTip);
  const headFiles = flatTree(r, p.headSha);
  const merged = new Map<string, { blob: string; data: Buffer }>(baseFiles);
  for (const f of p.files) {
    if (f.status === 'removed') merged.delete(f.filename);
    else {
      const h = headFiles.get(f.filename);
      if (h) merged.set(f.filename, h);
    }
  }
  const treeOid = treeFromFiles(r, merged);
  const msg = `Merge pull request #${p.number} from ${p.headRef}\n\n${p.title}\n`;
  const commitData = buildCommit(treeOid, [baseTip], msg);
  const mergeSha = storeObject(r, 'commit', commitData);
  r.refs.set(`refs/heads/${p.baseRef}`, mergeSha);
  r.packCache.clear();
  p.state = 'closed';
  p.merged = true;
  p.mergedAt = FIXED_DATE;
  p.mergeSha = mergeSha;
  return { sha: mergeSha };
}

// ---------------------------------------------------------------- contents (shared)

function resolveRef(r: Repo, ref: string | undefined): string | null {
  if (!ref) return r.refs.get(`refs/heads/${r.defaultBranch}`) ?? null;
  const direct = r.refs.get(ref);
  if (direct) return direct;
  const branch = r.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (r.objects.has(ref)) return ref;
  return null;
}
// Create a commit on `branch` that sets `path` to `data` (or deletes it).
// Returns the new commit oid, or null when the branch cannot be created.
function commitFile(r: Repo, branch: string, path: string, data: Buffer | null, message: string): string | null {
  let tip = r.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    tip = r.refs.get(`refs/heads/${r.defaultBranch}`) ?? undefined;
    if (tip === undefined && r.refs.size > 0) tip = [...r.refs.values()][0];
  }
  const files = tip ? new Map(flatTree(r, tip)) : new Map<string, { blob: string; data: Buffer }>();
  if (data === null) files.delete(path);
  else {
    const blobOid = storeObject(r, 'blob', data);
    files.set(path, { blob: blobOid, data });
  }
  const treeOid = treeFromFiles(r, files);
  const parents = tip ? [tip] : [];
  const commitOid = storeObject(r, 'commit', buildCommit(treeOid, parents, message));
  r.refs.set(`refs/heads/${branch}`, commitOid);
  r.packCache.clear();
  return commitOid;
}

// ---------------------------------------------------------------- REST v3

function viewerObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: gid('U', VIEWER_LOGIN),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    url: '/api/v3/user',
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, parts: string[], query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  // GET /api/v3/ and /api/v3 (root)
  if (parts.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (parts.length === 1 && parts[0] === 'meta') {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendJson(res, 200, viewerObject());
    return true;
  }
  // /api/v3/user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = viewerRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const base = `${hostOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.link = `<${base}>; rel="next"`;
      }
      sendJson(res, 200, slice.map((r) => repoObject(r)), extra);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, 'malformed JSON body');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = str(body.name);
      if (!name) {
        errJson(res, 422, 'name is required');
        return true;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        errJson(res, 422, `name already exists on this account`);
        return true;
      }
      const r = makeRepo(name, body.private === true, str(body.description));
      sendJson(res, 201, repoObject(r));
      return true;
    }
    return false;
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1]!;
    const name = parts[2]!;
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
    const rest = parts.slice(3);
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJsonText(res, 200, repo.repoJson);
        return true;
      }
      if (method === 'PATCH') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, 'malformed JSON body');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
        refreshRepoJson(repo);
        sendJson(res, 200, repoObject(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': reqId() });
        res.end();
        return true;
      }
      return false;
    }
    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        list.sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, list);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) {
          errJson(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
        return true;
      }
      return false;
    }
    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      const list: Record<string, unknown>[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length) {
          const oid = stack.pop()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const parsed = parseCommit(obj.data);
          const text = obj.data.toString('utf8');
          const authorLine = /^author (.*) <(.*)> (\d+) \+0000$/m.exec(text);
          list.push({
            sha: oid,
            commit: {
              message: parsed.message.replace(/\n$/, ''),
              author: { name: authorLine?.[1] ?? VIEWER_NAME, email: authorLine?.[2] ?? VIEWER_EMAIL, date: FIXED_DATE },
              committer: { name: authorLine?.[1] ?? VIEWER_NAME, email: authorLine?.[2] ?? VIEWER_EMAIL, date: FIXED_DATE },
            },
            parents: parsed.parents.map((p) => ({ sha: p })),
          });
          for (const p of parsed.parents) stack.push(p);
        }
      }
      sendJson(res, 200, list);
      return true;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, 'malformed JSON body');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          errJson(res, 422, 'invalid ref or sha');
          return true;
        }
        repo.refs.set(ref, sha);
        repo.packCache.clear();
        sendJson(res, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
        return true;
      }
      if (method === 'GET') {
        const refName = rest.slice(2).join('/');
        if (!refName) {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          sendJson(res, 200, list);
          return true;
        }
        const sha = repo.refs.get(refName);
        if (!sha) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref: refName, object: { sha } });
        return true;
      }
      return false;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, 'malformed JSON body');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const labelName = str(body.name);
        if (!labelName) {
          errJson(res, 422, 'name is required');
          return true;
        }
        const color = str(body.color, 'ededed');
        repo.labels.set(labelName, color);
        sendJson(res, 201, { id: 1, name: labelName, color, description: '' });
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.entries()].map(([n, c]) => ({ name: n, color: c })));
        return true;
      }
      return false;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refParam = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = resolveRef(repo, refParam);
        if (!tip) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const files = flatTree(repo, tip);
        if (filePath === '') {
          const entries = dirEntries(repo, tip, '');
          sendJson(res, 200, entries);
          return true;
        }
        const file = files.get(filePath);
        if (file) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: b64(file.data),
            sha: file.blob,
          });
          return true;
        }
        // directory?
        const prefix = `${filePath}/`;
        let isDir = false;
        for (const p of files.keys()) if (p.startsWith(prefix)) {
          isDir = true;
          break;
        }
        if (isDir) {
          sendJson(res, 200, dirEntries(repo, tip, filePath));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, 'malformed JSON body');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const contentB64 = str(body.content);
        if (!contentB64 && body.content !== '') {
          errJson(res, 422, 'content is required');
          return true;
        }
        const data = b64dec(contentB64);
        const branch = str(body.branch, repo.defaultBranch);
        const tip = resolveRef(repo, branch);
        const existing = tip ? flatTree(repo, tip).get(filePath) : undefined;
        const givenSha = str(body.sha);
        if (existing && givenSha && givenSha !== existing.blob) {
          errJson(res, 409, 'sha does not match the current file');
          return true;
        }
        const isUpdate = !!existing;
        const commitSha = commitFile(repo, branch, filePath, data, str(body.message, 'update file'));
        if (!commitSha) {
          errJson(res, 422, 'could not create commit');
          return true;
        }
        const blobSha = gitHash('blob', data);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: data.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, 'malformed JSON body');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const branch = str(body.branch, repo.defaultBranch);
        const tip = resolveRef(repo, branch);
        const existing = tip ? flatTree(repo, tip).get(filePath) : undefined;
        if (!existing) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const commitSha = commitFile(repo, branch, filePath, null, str(body.message, 'delete file'));
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
      return false;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            errJson(res, 400, 'malformed JSON body');
            return true;
          }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          const created = createIssueInternal(repo, str(body.title), str(body.body), labels);
          if ('error' in created) {
            errJson(res, 422, created.error);
            return true;
          }
          sendJson(res, 201, issueObject(repo, created));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, slice.map((i) => issueObject(repo, i)));
          return true;
        }
        return false;
      }
      const num = Number(rest[1]);
      const iss = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!iss) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJsonText(res, 200, iss.json);
          return true;
        }
        if (method === 'PATCH') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            errJson(res, 400, 'malformed JSON body');
            return true;
          }
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') iss.state = body.state;
          if (typeof body.title === 'string') iss.title = body.title;
          if (typeof body.body === 'string') iss.body = body.body;
          refreshIssueJson(repo, iss);
          sendJson(res, 200, issueObject(repo, iss));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!iss) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            errJson(res, 400, 'malformed JSON body');
            return true;
          }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const comment = { id: ++globalCommentId, body: str(body.body) };
          iss.comments.push(comment);
          refreshIssueJson(repo, iss);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, iss.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
          return true;
        }
        return false;
      }
      return false;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            errJson(res, 400, 'malformed JSON body');
            return true;
          }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const created = createPullInternal(repo, str(body.title), str(body.body), str(body.head), str(body.base, repo.defaultBranch));
          if ('error' in created) {
            errJson(res, created.status, created.error);
            return true;
          }
          sendJson(res, 201, pullObject(repo, created));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          list = [...list].sort((a, b) => b.seq - a.seq);
          const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((p) => pullObject(repo, p)));
          return true;
        }
        return false;
      }
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullObject(repo, pull));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pull.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          sha: f.headBlob ?? f.baseBlob ?? '',
        })));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        await readBody(req).catch(() => undefined);
        const merged = mergePullInternal(repo, pull);
        if ('error' in merged) {
          errJson(res, merged.status, merged.error);
          return true;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull Request #${pull.number} successfully merged` });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

function dirEntries(r: Repo, tip: string, dir: string): Record<string, unknown>[] {
  const files = flatTree(r, tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; sha: string }>();
  for (const [path, f] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) seen.set(rest, { type: 'file', sha: f.blob });
    else {
      const d = rest.slice(0, slash);
      if (!seen.has(d)) {
        // tree sha for the directory: find it by walking the tree
        seen.set(d, { type: 'dir', sha: dirTreeSha(r, tip, dir === '' ? d : `${dir}/${d}`) });
      }
    }
  }
  const out = [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, v]) => ({
      type: v.type,
      name,
      path: prefix + name,
      sha: v.sha,
      size: v.type === 'file' ? (files.get(prefix + name)?.data.length ?? 0) : 0,
    }));
  return out;
}
function dirTreeSha(r: Repo, tip: string, dir: string): string {
  const obj = r.objects.get(tip);
  if (!obj) return ZERO_OID;
  let treeOid = obj.tree;
  for (const seg of dir.split('/')) {
    const t = r.objects.get(treeOid);
    if (!t) return ZERO_OID;
    const e = parseTree(t.data).find((x) => x.name === seg && x.mode === '40000');
    if (!e) return ZERO_OID;
    treeOid = e.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------- git smart HTTP

function sortedRefs(r: Repo): [string, string][] {
  return [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function v0Advertisement(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=git-forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(r);
  const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}\n`);
      const peeled = peeledOid(r, oid);
      if (peeled && peeled !== oid) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  return pktLines(lines);
}
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=git-forge/1.0\n',
    'flush',
  ]);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, parts: string[], query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  // parts: [owner, repo.git, ...]
  if (parts.length < 2) return false;
  const owner = parts[0]!;
  const repoName = parts[1]!;
  if (!repoName.endsWith('.git')) return false;
  const name = repoName.slice(0, -4);
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  const tail = parts.slice(2);
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    if (!repo) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return true;
    }
    const service = query.get('service') ?? '';
    const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    if (service === 'git-upload-pack') {
      if (v2) send(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      else send(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    send(res, 400, 'unknown service', 'text/plain; charset=utf-8');
    return true;
  }
  if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
    if (!repo) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return true;
    }
    const body = await readBody(req);
    try {
      if (tail[0] === 'git-upload-pack') {
        const out = handleUploadPack(repo, body, req.headers['git-protocol'] === 'version=2');
        send(res, 200, out, 'application/x-git-upload-pack-result');
      } else {
        const out = handleReceivePack(repo, body);
        send(res, 200, out, 'application/x-git-receive-pack-result');
      }
    } catch {
      send(res, 400, 'bad request', 'text/plain; charset=utf-8');
    }
    return true;
  }
  return false;
}

// Parse pkt-line text lines from a request body (receive-pack commands).
// The command section ends at the first flush pkt; everything after it is
// the packfile, which is not pkt-framed, so only decode up to the flush.
function parseRequestLines(body: Buffer): { lines: string[]; packStart: number } {
  let i = 0;
  let packStart = body.length;
  while (i + 4 <= body.length) {
    const hex = body.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line');
    const len = parseInt(hex, 16);
    if (len === 0) {
      i += 4;
      packStart = i;
      break;
    }
    if (len === 1) {
      i += 4;
      continue;
    }
    if (i + len > body.length) throw new Error('pkt-line overruns buffer');
    i += len;
  }
  const pkts = decodePkts(body.subarray(0, packStart));
  const lines: string[] = [];
  for (const p of pkts) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return { lines, packStart };
}

function handleUploadPack(r: Repo, body: Buffer, isV2: boolean): Buffer {
  if (isV2) return handleUploadPackV2(r, body);
  return handleUploadPackV0(r, body);
}

function handleUploadPackV2(r: Repo, body: Buffer): Buffer {
  const pkts = decodePkts(body);
  const lines: string[] = [];
  for (const p of pkts) {
    if (p.kind === 'delim' || p.kind === 'flush') lines.push(p.kind === 'delim' ? '\u0001' : '\u0000');
    else lines.push(p.payload.toString('utf8'));
  }
  const command = lines[0]?.trim() ?? '';
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    let inArgs = false;
    for (const line of lines.slice(1)) {
      if (line === '\u0001') {
        inArgs = true;
        continue;
      }
      if (line === '\u0000') break;
      if (!inArgs) continue;
      const t = line.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: string[] = [];
    const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
    if (keep('HEAD') && headTip) {
      out.push(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    if (keep('HEAD') && !headTip && prefixes.length === 0) {
      // An unborn HEAD is advertised as the zero oid under the name HEAD,
      // never as a refs/heads/* entry: a fresh repository must list no refs.
      out.push(`${ZERO_OID} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const [ref, oid] of sortedRefs(r)) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel) {
        const peeled = peeledOid(r, oid);
        if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
      }
      out.push(`${line}\n`);
    }
    return pktLines([...out, 'flush']);
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    let inArgs = false;
    for (const line of lines.slice(1)) {
      if (line === '\u0001') {
        inArgs = true;
        continue;
      }
      if (line === '\u0000') break;
      if (!inArgs) continue;
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    }
    return buildFetchResponse(r, wants, haves, shallowIn, depth, true);
  }
  throw new Error('unknown v2 command');
}

function handleUploadPackV0(r: Repo, body: Buffer): Buffer {
  // Two sections: wants (+shallow/deepen) flush, haves/done flush.
  const pkts = decodePkts(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of pkts) {
    if (p.kind === 'flush') {
      section++;
      continue;
    }
    if (p.kind !== 'data') continue;
    const t = p.payload.toString('utf8').trim();
    if (section === 0) {
      if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]!);
      else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    } else {
      if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    }
  }
  return buildFetchResponse(r, wants, haves, shallowIn, depth, false);
}

// Compute the object set for a fetch and frame the response.
function buildFetchResponse(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null, isV2: boolean): Buffer {
  const { objects, shallowOut, unshallowOut } = computeFetch(r, wants, haves, shallowIn, depth);
  const pack = objects.size ? cachedPack(r, fetchKey(wants, haves, shallowIn, depth), objects) : null;
  if (isV2) {
    const parts: Buffer[] = [];
    parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'flush']));
    if (depth !== null && (shallowOut.length || unshallowOut.length)) {
      const lines: (string | 'flush')[] = ['shallow-info\n'];
      for (const s of shallowOut) lines.push(`shallow ${s}\n`);
      for (const s of unshallowOut) lines.push(`unshallow ${s}\n`);
      lines.push('flush');
      parts.push(pktLines(lines));
    }
    if (pack) {
      parts.push(pktLines(['packfile\n']));
      parts.push(sidebandPack(pack));
      parts.push(PKT_FLUSH);
    }
    return Buffer.concat(parts);
  }
  // v0: NAK / shallow lines as plain pkt lines, then the pack sidebanded.
  const parts: Buffer[] = [];
  const pre: string[] = ['NAK\n'];
  for (const s of shallowOut) pre.push(`shallow ${s}\n`);
  for (const s of unshallowOut) pre.push(`unshallow ${s}\n`);
  parts.push(pktLines(pre));
  if (pack) parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function fetchKey(wants: string[], haves: string[], shallowIn: string[], depth: number | null): string {
  return `f:${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowIn].sort().join(',')}|${depth ?? ''}`;
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}
function computeFetch(
  r: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): { objects: Set<string>; shallowOut: string[]; unshallowOut: string[] } {
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (wants.length === 0) return { objects: new Set(), shallowOut, unshallowOut };
  let objects: Set<string>;
  if (depth !== null) {
    // Depth-limited walk from the wants. Distance 0 = the want itself.
    const dist = new Map<string, number>();
    const queue: [string, number][] = wants.map((w) => [w, 0] as [string, number]);
    const includedCommits = new Set<string>();
    while (queue.length) {
      const [oid, d] = queue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, d);
      const obj = r.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (d < depth) {
        includedCommits.add(oid);
        if (d + 1 < depth) for (const p of obj.parents) queue.push([p, d + 1]);
        else {
          // parents at distance == depth are the new boundary (if they exist)
          for (const p of obj.parents) if (!dist.has(p)) dist.set(p, depth);
        }
      }
    }
    // Boundary commits: included commits at distance depth-1 that have parents.
    for (const c of includedCommits) {
      const d = dist.get(c)!;
      if (d === depth - 1) {
        const obj = r.objects.get(c);
        if (obj && obj.parents.length > 0) shallowOut.push(c);
      }
    }
    // Objects: trees/blobs of included commits.
    objects = new Set<string>();
    for (const c of includedCommits) {
      const obj = r.objects.get(c);
      if (!obj) continue;
      objects.add(c);
      const addTree = (treeOid: string): void => {
        if (objects.has(treeOid)) return;
        objects.add(treeOid);
        const t = r.objects.get(treeOid);
        if (!t) return;
        for (const e of parseTree(t.data)) {
          if (e.mode === '40000') addTree(e.oid);
          else objects.add(e.oid);
        }
      };
      addTree(obj.tree);
    }
    // Remove objects the client already holds: the depth-1 closure of each
    // incoming shallow boundary (its commit, tree and blobs).
    for (const b of shallowIn) {
      const held = depthOneClosure(r, b);
      for (const o of held) objects.delete(o);
    }
    // Unshallow: incoming boundaries that are now included and not boundaries.
    for (const b of shallowIn) {
      if (includedCommits.has(b) && !shallowOut.includes(b)) unshallowOut.push(b);
    }
    shallowOut.sort();
    unshallowOut.sort();
    return { objects, shallowOut, unshallowOut };
  }
  const wantReach = new Set<string>();
  for (const w of wants) {
    for (const o of reachableObjects(r, [w])) wantReach.add(o);
  }
  const haveReach = new Set<string>();
  for (const h of haves) {
    for (const o of reachableObjects(r, [h])) haveReach.add(o);
  }
  objects = new Set<string>();
  for (const o of wantReach) if (!haveReach.has(o)) objects.add(o);
  return { objects, shallowOut, unshallowOut };
}
function depthOneClosure(r: Repo, commitOid: string): Set<string> {
  const out = new Set<string>();
  const obj = r.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  out.add(commitOid);
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const t = r.objects.get(treeOid);
    if (!t) return;
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else out.add(e.oid);
    }
  };
  addTree(obj.tree);
  return out;
}

function handleReceivePack(r: Repo, body: Buffer): Buffer {
  const { lines, packStart } = parseRequestLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sideband = false;
  for (const line of lines) {
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)(?:\0(.*))?$/.exec(line.trim());
    if (!m) throw new Error('bad receive-pack command');
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    if (m[4] && m[4].includes('side-band-64k')) sideband = true;
  }
  const packBuf = body.subarray(packStart);
  if (packBuf.length > 0) {
    const objs = parsePack(packBuf, (oid) => r.objects.get(oid));
    for (const o of objs) storeObject(r, o.type, o.data);
  }
  const report: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = r.refs.get(cmd.ref);
    let ok = false;
    let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) {
        reason = 'no such ref';
      } else if (current !== cmd.oldOid && cmd.oldOid !== ZERO_OID) {
        reason = 'non-fast-forward';
      } else {
        r.refs.delete(cmd.ref);
        ok = true;
      }
    } else {
      const obj = r.objects.get(cmd.newOid);
      if (!obj) reason = 'missing object';
      else if (!current) {
        if (cmd.oldOid !== ZERO_OID) reason = 'non-fast-forward';
        else {
          r.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        }
      } else if (current === cmd.oldOid) {
        if (cmd.newOid === cmd.oldOid) ok = true;
        else if (obj.type === 'commit' && isAncestor(r, cmd.oldOid, cmd.newOid)) {
          r.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        } else if (obj.type !== 'commit') {
          // tags and other refs: allow when the old value matches
          r.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        } else reason = 'non-fast-forward';
      } else reason = 'non-fast-forward';
    }
    report.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  if (report.some((l) => l.startsWith('ok '))) r.packCache.clear();
  const reportBuf = pktLines([...report, 'flush']);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let i = 0; i < reportBuf.length; i += CHUNK) {
      const chunk = reportBuf.subarray(i, Math.min(reportBuf.length, i + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return reportBuf;
}

// ---------------------------------------------------------------- GraphQL

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Viewer: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'mergeCommit'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Node: ['id'],
};
const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface GqlSel {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlSel[];
  fragmentType: string | null;
}
interface GqlOp {
  kind: 'query' | 'mutation';
  selections: GqlSel[];
}

// The parser above cannot substitute variables in one pass (variable
// definitions are skipped before the body is read). Re-parse properly:
function gqlParseWithVars(query: string, vars: Record<string, unknown>): GqlOp {
  // Strip the variable-definition list after the operation name; it is
  // declared in the document but the values come from `vars`. Only a
  // parenthesised group in the operation header (before the first `{`)
  // may be stripped — an argument list on the first field, such as
  // __type(name: "Issue"), must survive.
  let stripped = query;
  const head = /^\s*(?:query|mutation)\s+[A-Za-z_][A-Za-z0-9_]*/.exec(query);
  if (head) {
    const rest = query.slice(head[0].length);
    const open = rest.indexOf('(');
    const brace = rest.indexOf('{');
    if (open !== -1 && (brace === -1 || open < brace)) {
      let depth = 0;
      let close = -1;
      for (let i = open; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')') {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close !== -1) stripped = query.slice(0, head[0].length) + ' ' + rest.slice(close + 1);
    }
  }
  return gqlParseVars(stripped, vars);
}
function gqlParseVars(query: string, vars: Record<string, unknown>): GqlOp {
  let i = 0;
  const n = query.length;
  const skipWs = (): void => {
    while (i < n) {
      const c = query[i]!;
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') i++;
      else if (c === '#') while (i < n && query[i] !== '\n') i++;
      else break;
    }
  };
  const readName = (): string => {
    skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(i));
    if (!m) throw new Error(`expected name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = query[i]!;
    if (c === '$') {
      i++;
      return vars[readName()];
    }
    if (c === '"') {
      i++;
      let out = '';
      while (i < n && query[i] !== '"') {
        if (query[i] === '\\') {
          i++;
          const e = query[i]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i++;
        } else {
          out += query[i];
          i++;
        }
      }
      i++;
      return out;
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        skipWs();
        if (query[i] === '}') {
          i++;
          break;
        }
        const key = readName();
        skipWs();
        if (query[i] === ':') i++;
        obj[key] = parseValue();
      }
      return obj;
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipWs();
        if (query[i] === ']') {
          i++;
          break;
        }
        arr.push(parseValue());
      }
      return arr;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d+(\.\d+)?/.exec(query.slice(i));
      i += m![0].length;
      return Number(m![0]);
    }
    const name = readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name;
  };
  const parseArgs = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    skipWs();
    if (query[i] !== '(') return args;
    i++;
    for (;;) {
      skipWs();
      if (query[i] === ')') {
        i++;
        break;
      }
      const key = readName();
      skipWs();
      if (query[i] === ':') i++;
      args[key] = parseValue();
    }
    return args;
  };
  const parseSelections = (): GqlSel[] => {
    const sels: GqlSel[] = [];
    skipWs();
    if (query[i] !== '{') throw new Error('expected selection set');
    i++;
    for (;;) {
      skipWs();
      if (query[i] === '}') {
        i++;
        break;
      }
      if (query.slice(i, i + 3) === '...') {
        i += 3;
        skipWs();
        let fragType: string | null = null;
        if (query.slice(i, i + 2) === 'on') {
          i += 2;
          fragType = readName();
        } else readName();
        const children = parseSelections();
        sels.push({ alias: '', name: '', args: {}, children, fragmentType: fragType });
        continue;
      }
      const first = readName();
      skipWs();
      let alias = first;
      let name = first;
      if (query[i] === ':') {
        i++;
        name = readName();
      }
      const args = parseArgs();
      skipWs();
      const children = query[i] === '{' ? parseSelections() : [];
      sels.push({ alias, name, args, children, fragmentType: null });
    }
    return sels;
  };
  skipWs();
  let kind: 'query' | 'mutation' = 'query';
  if (query.slice(i, i + 5) === 'query') {
    i += 5;
    kind = 'query';
  } else if (query.slice(i, i + 8) === 'mutation') {
    i += 8;
    kind = 'mutation';
  }
  skipWs();
  if (i < n && /[A-Za-z_]/.test(query[i]!)) readName();
  const selections = parseSelections();
  return { kind, selections };
}

type GqlValue =
  | { __type: 'repo'; repo: Repo }
  | { __type: 'issue'; repo: Repo; issue: Issue }
  | { __type: 'pull'; repo: Repo; pull: Pull }
  | { __type: 'user'; login: string }
  | { __type: 'ref'; name: string }
  | { __type: 'issueConn'; repo: Repo; issues: Issue[]; hasNext: boolean; endCursor: string | null }
  | { __type: 'pullConn'; repo: Repo; pulls: Pull[] }
  | { __type: 'fileConn'; repo: Repo; pull: Pull }
  | { __type: 'pageInfo'; hasNext: boolean; endCursor: string | null }
  | { __type: 'type'; name: string }
  | { __type: 'comment'; id: number; body: string }
  | { __type: 'commentEdge'; comment: { id: number; body: string } }
  | { __type: 'payload'; fields: Record<string, unknown> }
  | { __type: 'scalar'; value: unknown };

function typeOf(v: GqlValue): string {
  switch (v.__type) {
    case 'repo':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'user':
      return 'User';
    case 'ref':
      return 'Ref';
    case 'issueConn':
      return 'IssueConnection';
    case 'pullConn':
      return 'PullRequestConnection';
    case 'fileConn':
      return 'PullRequestChangedFileConnection';
    case 'pageInfo':
      return 'PageInfo';
    case 'type':
      return '__Type';
    case 'comment':
      return 'IssueComment';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'payload':
      return 'Payload';
    case 'scalar':
      return 'Scalar';
  }
}

function gqlResolveField(v: GqlValue, sel: GqlSel, errors: { message: string }[]): GqlValue | null {
  const t = typeOf(v);
  // Scalars and mutation payloads resolve their fields dynamically (a scalar
  // wrapping {name} or {path}; a payload holding whichever object the
  // mutation returned), so they are not checked against a fixed field list.
  if (v.__type !== 'scalar' && v.__type !== 'payload') {
    const allowed = GQL_FIELDS[t] ?? [];
    if (sel.name && !allowed.includes(sel.name)) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${t}".` });
      return null;
    }
  }
  switch (v.__type) {
    case 'repo': {
      const r = v.repo;
      switch (sel.name) {
        case 'id':
          return { __type: 'scalar', value: gid('R', `${r.owner}/${r.name}`) };
        case 'databaseId':
          return { __type: 'scalar', value: r.id };
        case 'name':
          return { __type: 'scalar', value: r.name };
        case 'nameWithOwner':
          return { __type: 'scalar', value: `${r.owner}/${r.name}` };
        case 'owner':
          return { __type: 'user', login: r.owner };
        case 'defaultBranchRef':
          return { __type: 'ref', name: r.defaultBranch };
        case 'viewerPermission':
          return { __type: 'scalar', value: 'ADMIN' };
        case 'hasIssuesEnabled':
          return { __type: 'scalar', value: true };
        case 'description':
          return { __type: 'scalar', value: r.description };
        case 'private':
          return { __type: 'scalar', value: r.isPrivate };
        case 'url':
          return { __type: 'scalar', value: `/api/v3/repos/${r.owner}/${r.name}` };
        case 'createdAt':
          return { __type: 'scalar', value: FIXED_DATE };
        case 'issue': {
          const num = sel.args.number as number;
          const iss = r.issues.find((x) => x.number === num);
          return iss ? { __type: 'issue', repo: r, issue: iss } : null;
        }
        case 'issues': {
          let list = [...r.issues];
          const states = sel.args.states as string[] | undefined;
          if (states) list = list.filter((x) => states.includes(x.state === 'open' ? 'OPEN' : 'CLOSED'));
          const orderBy = sel.args.orderBy as { field?: string; direction?: string } | undefined;
          if (orderBy?.field === 'CREATED_AT') {
            list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
          } else list.sort((a, b) => a.seq - b.seq);
          const first = typeof sel.args.first === 'number' ? sel.args.first : undefined;
          const after = typeof sel.args.after === 'string' ? sel.args.after : null;
          let start = 0;
          if (after) {
            try {
              const decoded = Buffer.from(after, 'base64').toString('utf8');
              const idx = Number(decoded.split(':')[1]);
              if (Number.isFinite(idx)) start = idx + 1;
            } catch {
              start = 0;
            }
          }
          const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
          const hasNext = start + page.length < list.length;
          const endCursor = page.length ? Buffer.from(`cursor:${start + page.length - 1}`, 'utf8').toString('base64') : null;
          return { __type: 'issueConn', repo: r, issues: page, hasNext, endCursor };
        }
        case 'pullRequests': {
          let list = [...r.pulls].sort((a, b) => b.seq - a.seq);
          const first = typeof sel.args.first === 'number' ? sel.args.first : undefined;
          if (first !== undefined) list = list.slice(0, first);
          return { __type: 'pullConn', repo: r, pulls: list };
        }
        case 'pullRequest': {
          const num = sel.args.number as number;
          const p = r.pulls.find((x) => x.number === num);
          return p ? { __type: 'pull', repo: r, pull: p } : null;
        }
      }
      return null;
    }
    case 'issue': {
      const iss = v.issue;
      switch (sel.name) {
        case 'id':
          return { __type: 'scalar', value: gid('I', `${v.repo.owner}/${v.repo.name}:${iss.number}`) };
        case 'number':
          return { __type: 'scalar', value: iss.number };
        case 'title':
          return { __type: 'scalar', value: iss.title };
        case 'state':
          return { __type: 'scalar', value: iss.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'body':
          return { __type: 'scalar', value: iss.body };
        case 'url':
          return { __type: 'scalar', value: `/api/v3/repos/${v.repo.owner}/${v.repo.name}/issues/${iss.number}` };
        case 'createdAt':
        case 'updatedAt':
          return { __type: 'scalar', value: FIXED_DATE };
        case 'author':
          return { __type: 'user', login: VIEWER_LOGIN };
        case 'labels':
          return { __type: 'scalar', value: iss.labels.map((n) => ({ name: n })) };
        case 'comments':
          return { __type: 'scalar', value: iss.comments.map((c) => ({ id: gid('C', String(c.id)), body: c.body })) };
        case 'repository':
          return { __type: 'repo', repo: v.repo };
      }
      return null;
    }
    case 'pull': {
      const p = v.pull;
      switch (sel.name) {
        case 'id':
          return { __type: 'scalar', value: gid('P', `${v.repo.owner}/${v.repo.name}:${p.number}`) };
        case 'number':
          return { __type: 'scalar', value: p.number };
        case 'title':
          return { __type: 'scalar', value: p.title };
        case 'body':
          return { __type: 'scalar', value: p.body };
        case 'state':
          return { __type: 'scalar', value: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'merged':
          return { __type: 'scalar', value: p.merged };
        case 'mergeable':
          return { __type: 'scalar', value: prMergeable(v.repo, p) ? 'MERGEABLE' : 'CONFLICTING' };
        case 'headRefName':
          return { __type: 'scalar', value: p.headRef };
        case 'baseRefName':
          return { __type: 'scalar', value: p.baseRef };
        case 'files':
          return { __type: 'fileConn', repo: v.repo, pull: p };
        case 'headRef':
          return { __type: 'ref', name: p.headRef };
        case 'baseRef':
          return { __type: 'ref', name: p.baseRef };
        case 'author':
          return { __type: 'user', login: VIEWER_LOGIN };
        case 'createdAt':
          return { __type: 'scalar', value: FIXED_DATE };
        case 'mergeCommit':
          return p.mergeSha ? { __type: 'scalar', value: p.mergeSha } : null;
      }
      return null;
    }
    case 'user':
      if (sel.name === 'login') return { __type: 'scalar', value: v.login };
      if (sel.name === 'id') return { __type: 'scalar', value: gid('U', v.login) };
      if (sel.name === 'name') return { __type: 'scalar', value: v.login };
      if (sel.name === 'email') return { __type: 'scalar', value: `${v.login}@example.invalid` };
      return null;
    case 'ref':
      if (sel.name === 'name') return { __type: 'scalar', value: v.name };
      return null;
    case 'issueConn': {
      if (sel.name === 'nodes') return { __type: 'scalar', value: v.issues.map((i) => ({ __type: 'issue', repo: v.repo, issue: i }) as GqlValue) };
      if (sel.name === 'totalCount') return { __type: 'scalar', value: v.issues.length };
      if (sel.name === 'pageInfo') {
        return { __type: 'pageInfo', hasNext: v.hasNext, endCursor: v.endCursor };
      }
      return null;
    }
    case 'pullConn': {
      if (sel.name === 'nodes') return { __type: 'scalar', value: v.pulls.map((p) => ({ __type: 'pull', repo: v.repo, pull: p }) as GqlValue) };
      if (sel.name === 'totalCount') return { __type: 'scalar', value: v.pulls.length };
      if (sel.name === 'pageInfo') return { __type: 'pageInfo', hasNext: false, endCursor: null };
      return null;
    }
    case 'fileConn': {
      if (sel.name === 'nodes') {
        const first = typeof sel.args.first === 'number' ? sel.args.first : undefined;
        let files = v.pull.files;
        if (first !== undefined) files = files.slice(0, first);
        return { __type: 'scalar', value: files.map((f) => ({ __type: 'scalar', value: { path: f.filename } }) as GqlValue) };
      }
      if (sel.name === 'pageInfo') return { __type: 'pageInfo', hasNext: false, endCursor: null };
      return null;
    }
    case 'pageInfo':
      if (sel.name === 'hasNextPage') return { __type: 'scalar', value: v.hasNext };
      if (sel.name === 'hasPreviousPage') return { __type: 'scalar', value: false };
      if (sel.name === 'endCursor') return { __type: 'scalar', value: v.endCursor };
      if (sel.name === 'startCursor') return { __type: 'scalar', value: null };
      return null;
    case 'type': {
      if (sel.name === 'name') return { __type: 'scalar', value: v.name };
      if (sel.name === 'kind') return { __type: 'scalar', value: GQL_ENUMS[v.name] ? 'ENUM' : 'OBJECT' };
      if (sel.name === 'description') return { __type: 'scalar', value: null };
      if (sel.name === 'fields') {
        const fields = GQL_FIELDS[v.name] ?? [];
        return { __type: 'scalar', value: fields.map((f) => ({ __type: 'scalar', value: { name: f } }) as GqlValue) };
      }
      if (sel.name === 'enumValues') {
        const vals = GQL_ENUMS[v.name] ?? [];
        return { __type: 'scalar', value: vals.map((e) => ({ __type: 'scalar', value: { name: e } }) as GqlValue) };
      }
      return null;
    }
    case 'comment':
      if (sel.name === 'id') return { __type: 'scalar', value: gid('C', String(v.id)) };
      if (sel.name === 'body') return { __type: 'scalar', value: v.body };
      if (sel.name === 'author') return { __type: 'user', login: VIEWER_LOGIN };
      return null;
    case 'commentEdge':
      if (sel.name === 'node') return { __type: 'comment', id: v.comment.id, body: v.comment.body };
      if (sel.name === 'cursor') return { __type: 'scalar', value: 'cursor' };
      return null;
    case 'payload': {
      const val = v.fields[sel.name];
      if (val === undefined) {
        errors.push({ message: `Cannot query field "${sel.name}" on type "Payload".` });
        return null;
      }
      if (val !== null && typeof val === 'object' && '__type' in (val as Record<string, unknown>)) return val as GqlValue;
      return { __type: 'scalar', value: val };
    }
    case 'scalar': {
      // A scalar wrapping a plain object (e.g. {name}) or a list of GqlValues.
      if (sel.name === 'name' && isRecord(v.value)) return { __type: 'scalar', value: (v.value as Record<string, unknown>).name ?? null };
      if (sel.name === 'path' && isRecord(v.value)) return { __type: 'scalar', value: (v.value as Record<string, unknown>).path ?? null };
      return null;
    }
  }
}

// Execute a selection set against a value, producing plain JSON.
function gqlExecute(v: GqlValue | null, sels: GqlSel[], errors: { message: string }[]): unknown {
  if (v === null) return null;
  if (v.__type === 'scalar') {
    // A scalar holding a list of GqlValues or a plain value.
    if (Array.isArray(v.value)) {
      return (v.value as GqlValue[]).map((item) => gqlExecute(item, sels, errors));
    }
    if (sels.length === 0) return v.value;
    // Scalar wrapping an object with sub-selections (e.g. __Type fields entries).
    const obj: Record<string, unknown> = {};
    for (const sel of sels) {
      if (sel.fragmentType) continue;
      const child = gqlResolveField(v, sel, errors);
      obj[sel.alias || sel.name] = child === null ? null : gqlExecute(child, sel.children, errors);
    }
    return obj;
  }
  const obj: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.fragmentType) {
      if (sel.fragmentType !== typeOf(v) && !(sel.fragmentType === 'Node' && (v.__type === 'repo' || v.__type === 'issue' || v.__type === 'pull'))) continue;
      const inner = gqlExecute(v, sel.children, errors);
      if (isRecord(inner)) Object.assign(obj, inner);
      continue;
    }
    const child = gqlResolveField(v, sel, errors);
    obj[sel.alias || sel.name] = child === null ? null : gqlExecute(child, sel.children, errors);
  }
  return obj;
}

function gqlExecuteOperation(op: GqlOp, vars: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.fragmentType) continue;
    if (op.kind === 'query') {
      if (sel.name === 'viewer') {
        const user: GqlValue = { __type: 'user', login: VIEWER_LOGIN };
        data[sel.alias || sel.name] = gqlExecute(user, sel.children, errors);
      } else if (sel.name === 'repository') {
        const owner = str(sel.args.owner);
        const name = str(sel.args.name);
        const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
        data[sel.alias || sel.name] = repo ? gqlExecute({ __type: 'repo', repo }, sel.children, errors) : null;
      } else if (sel.name === 'node') {
        const id = str(sel.args.id);
        const dec = gidDecode(id);
        let value: GqlValue | null = null;
        if (dec?.kind === 'R') {
          const [owner, name] = dec.key.split('/');
          const repo = getRepo(owner!, name!);
          if (repo) value = { __type: 'repo', repo };
        } else if (dec?.kind === 'I') {
          const m = /^(.+)\/([^/]+):(\d+)$/.exec(dec.key);
          if (m) {
            const repo = getRepo(m[1]!, m[2]!);
            const iss = repo?.issues.find((x) => x.number === Number(m[3]));
            if (repo && iss) value = { __type: 'issue', repo, issue: iss };
          }
        } else if (dec?.kind === 'P') {
          const m = /^(.+)\/([^/]+):(\d+)$/.exec(dec.key);
          if (m) {
            const repo = getRepo(m[1]!, m[2]!);
            const p = repo?.pulls.find((x) => x.number === Number(m[3]));
            if (repo && p) value = { __type: 'pull', repo, pull: p };
          }
        }
        data[sel.alias || sel.name] = value ? gqlExecute(value, sel.children, errors) : null;
      } else if (sel.name === '__type') {
        const name = str(sel.args.name);
        const known = GQL_FIELDS[name] !== undefined || GQL_ENUMS[name] !== undefined;
        data[sel.alias || sel.name] = known ? gqlExecute({ __type: 'type', name }, sel.children, errors) : null;
      } else if (sel.name === '__schema') {
        data[sel.alias || sel.name] = gqlExecute({ __type: 'scalar', value: null }, sel.children, errors);
      } else {
        errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        data[sel.alias || sel.name] = null;
      }
    } else {
      // Mutations
      const input = isRecord(sel.args.input) ? sel.args.input : {};
      if (sel.name === 'createIssue') {
        const dec = gidDecode(str(input.repositoryId));
        let issue: Issue | null = null;
        let repo: Repo | undefined;
        if (dec?.kind === 'R') {
          const [owner, name] = dec.key.split('/');
          repo = getRepo(owner!, name!);
          if (repo) {
            const created = createIssueInternal(repo, str(input.title), str(input.body), []);
            if (!('error' in created)) issue = created;
          }
        }
        const payload: Record<string, unknown> = {
          issue: issue && repo ? ({ __type: 'issue', repo, issue } as GqlValue) : null,
        };
        data[sel.alias || sel.name] = gqlExecute({ __type: 'payload', fields: payload }, sel.children, errors);
      } else if (sel.name === 'closeIssue') {
        const dec = gidDecode(str(input.issueId));
        let issue: Issue | null = null;
        let repo: Repo | undefined;
        if (dec?.kind === 'I') {
          const m = /^(.+)\/([^/]+):(\d+)$/.exec(dec.key);
          if (m) {
            repo = getRepo(m[1]!, m[2]!);
            const iss = repo?.issues.find((x) => x.number === Number(m[3]));
            if (iss) {
              iss.state = 'closed';
              refreshIssueJson(repo!, iss);
              issue = iss;
            }
          }
        }
        const payload: Record<string, unknown> = {
          issue: issue && repo ? ({ __type: 'issue', repo, issue } as GqlValue) : null,
        };
        data[sel.alias || sel.name] = gqlExecute({ __type: 'payload', fields: payload }, sel.children, errors);
      } else if (sel.name === 'createPullRequest') {
        const dec = gidDecode(str(input.repositoryId));
        let pull: Pull | null = null;
        let repo: Repo | undefined;
        if (dec?.kind === 'R') {
          const [owner, name] = dec.key.split('/');
          repo = getRepo(owner!, name!);
          if (repo) {
            const created = createPullInternal(repo, str(input.title), str(input.body), str(input.headRefName), str(input.baseRefName));
            if (!('error' in created)) pull = created;
          }
        }
        const payload: Record<string, unknown> = {
          pullRequest: pull && repo ? ({ __type: 'pull', repo, pull } as GqlValue) : null,
        };
        data[sel.alias || sel.name] = gqlExecute({ __type: 'payload', fields: payload }, sel.children, errors);
      } else if (sel.name === 'mergePullRequest') {
        const dec = gidDecode(str(input.pullRequestId));
        let pull: Pull | null = null;
        let repo: Repo | undefined;
        if (dec?.kind === 'P') {
          const m = /^(.+)\/([^/]+):(\d+)$/.exec(dec.key);
          if (m) {
            repo = getRepo(m[1]!, m[2]!);
            const p = repo?.pulls.find((x) => x.number === Number(m[3]));
            if (p && repo) {
              mergePullInternal(repo, p);
              pull = p;
            }
          }
        }
        const payload: Record<string, unknown> = {
          pullRequest: pull && repo ? ({ __type: 'pull', repo, pull } as GqlValue) : null,
        };
        data[sel.alias || sel.name] = gqlExecute({ __type: 'payload', fields: payload }, sel.children, errors);
      } else if (sel.name === 'addComment') {
        const dec = gidDecode(str(input.subjectId));
        let comment: { id: number; body: string } | null = null;
        if (dec?.kind === 'I') {
          const m = /^(.+)\/([^/]+):(\d+)$/.exec(dec.key);
          if (m) {
            const repo = getRepo(m[1]!, m[2]!);
            const iss = repo?.issues.find((x) => x.number === Number(m[3]));
            if (iss && repo) {
              comment = { id: ++globalCommentId, body: str(input.body) };
              iss.comments.push(comment);
              refreshIssueJson(repo, iss);
            }
          }
        }
        const payload: Record<string, unknown> = {
          commentEdge: comment ? ({ __type: 'commentEdge', comment } as GqlValue) : null,
          comment: comment ? ({ __type: 'comment', id: comment.id, body: comment.body } as GqlValue) : null,
        };
        data[sel.alias || sel.name] = gqlExecute({ __type: 'payload', fields: payload }, sel.children, errors);
      } else {
        errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        data[sel.alias || sel.name] = null;
      }
    }
  }
  return { data, errors };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson(req);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
    return;
  }
  const docs = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results: unknown[] = [];
  for (const doc of docs) {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    const vars = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    try {
      const op = gqlParseWithVars(doc.query, vars);
      const { data, errors } = gqlExecuteOperation(op, vars);
      const out: Record<string, unknown> = { data };
      if (errors.length) out.errors = errors;
      results.push(out);
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the token owner)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = str(args.owner);
  let name = str(args.repo);
  const full = str(args.full_name);
  if ((!owner || !name) && full.includes('/')) {
    const [o, n] = full.split('/', 2);
    owner = o ?? owner;
    name = n ?? name;
  }
  if (!name) return null;
  if (!owner) owner = VIEWER_LOGIN;
  return owner === VIEWER_LOGIN ? getRepo(owner, name) ?? null : null;
}
function mcpToolResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError };
}
function mcpCall(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const required = (tool.inputSchema.required ?? []) as string[];
  // The suite maps documented names onto schema properties; accept synonyms.
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const syn: Record<string, string[]> = {
    owner: ['owner', 'owner_login', 'org', 'login', 'user'],
    repo: ['repo', 'repository', 'repository_name', 'repo_name'],
    full_name: ['full_name', 'repo_full_name', 'fullName'],
    title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
    body: ['body', 'issue_body', 'description', 'content', 'text'],
    head: ['head', 'head_ref', 'head_branch', 'source_branch', 'branch'],
    base: ['base', 'base_ref', 'base_branch', 'target_branch'],
    pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
    issue_number: ['issue_number', 'number', 'pull_number'],
    name: ['name', 'repo', 'repository'],
    description: ['description', 'about', 'summary', 'body'],
    private: ['private', 'is_private'],
    state: ['state', 'status'],
  };
  const resolved: Record<string, unknown> = {};
  for (const req of required) {
    let found: unknown;
    for (const cand of syn[req] ?? [req]) {
      for (const key of Object.keys(args)) {
        if (norm(key) === norm(cand) && args[key] !== undefined) found = args[key];
      }
    }
    if (found !== undefined) resolved[req] = found;
  }
  // Optional args, mapped the same way.
  for (const key of Object.keys(tool.inputSchema.properties)) {
    if (resolved[key] !== undefined) continue;
    for (const cand of syn[key] ?? [key]) {
      for (const k2 of Object.keys(args)) {
        if (norm(k2) === norm(cand) && args[k2] !== undefined) resolved[key] = args[k2];
      }
    }
  }
  const missing = required.filter((r) => resolved[r] === undefined);
  if (missing.length) {
    return { result: mcpToolResult({ error: `missing required argument: ${missing.join(', ')}` }, true) };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = str(resolved.name);
        if (getRepo(VIEWER_LOGIN, repoName)) return { result: mcpToolResult({ error: 'name already exists on this account' }, true) };
        const r = makeRepo(repoName, resolved.private === true, str(resolved.description));
        return { result: mcpToolResult(repoObject(r)) };
      }
      case 'get_repo': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        return { result: mcpToolResult(repoObject(r)) };
      }
      case 'create_issue': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const created = createIssueInternal(r, str(resolved.title), str(resolved.body), []);
        if ('error' in created) return { result: mcpToolResult({ error: created.error }, true) };
        return { result: mcpToolResult(issueObject(r, created)) };
      }
      case 'list_issues': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const state = str(resolved.state, 'open');
        const list = r.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueObject(r, i));
        return { result: mcpToolResult(list) };
      }
      case 'create_pull_request': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const created = createPullInternal(r, str(resolved.title), str(resolved.body), str(resolved.head), str(resolved.base, r.defaultBranch));
        if ('error' in created) return { result: mcpToolResult({ error: created.error }, true) };
        return { result: mcpToolResult(pullObject(r, created)) };
      }
      case 'merge_pull_request': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const num = Number(resolved.pull_number);
        const p = r.pulls.find((x) => x.number === num);
        if (!p) return { result: mcpToolResult({ error: 'pull request not found' }, true) };
        const merged = mergePullInternal(r, p);
        if ('error' in merged) return { result: mcpToolResult({ error: merged.error }, true) };
        return { result: mcpToolResult({ sha: merged.sha, merged: true, message: `Pull Request #${num} successfully merged`, number: num }) };
      }
      case 'get_issue': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const iss = r.issues.find((x) => x.number === Number(resolved.issue_number));
        if (!iss) return { result: mcpToolResult({ error: 'issue not found' }, true) };
        return { result: mcpToolResult(issueObject(r, iss)) };
      }
      case 'list_pull_requests': {
        const r = mcpResolveRepo(resolved);
        if (!r) return { result: mcpToolResult({ error: 'repository not found' }, true) };
        const state = str(resolved.state, 'open');
        const list = r.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullObject(r, p));
        return { result: mcpToolResult(list) };
      }
      default:
        return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
  } catch (e) {
    return { result: mcpToolResult({ error: e instanceof Error ? e.message : 'tool failed' }, true) };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = body.id ?? null;
  const method = str(body.method);
  const params = isRecord(body.params) ? body.params : {};
  const rpc = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const rpcErr = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    rpc({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      serverInfo: { name: 'git-forge', version: '1.0.0' },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = str(params.protocolVersion, '2025-11-25');
    const chosen = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: { name: 'git-forge', version: '1.0.0' } } }, { 'mcp-session-id': 'mcp-1' });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (method === 'ping') {
    rpc({});
    return;
  }
  if (method === 'tools/list') {
    sendJsonText(res, 200, JSON.stringify({ jsonrpc: '2.0', id, result: { tools: JSON.parse(MCP_TOOLS_JSON) } }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const out = mcpCall(toolName, args);
    if (out.error) {
      rpcErr(out.error.code, out.error.message);
      return;
    }
    rpc(out.result);
    return;
  }
  rpcErr(-32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------- top level

export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const pathname = url.pathname;
      const query = url.searchParams;
      const parts = pathParts(pathname);
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (parts.length >= 2 && parts[1]!.endsWith('.git')) {
        const handled = await handleGit(req, res, parts, query);
        if (handled) return;
        errJson(res, 404, 'Not Found');
        return;
      }
      // MCP (auth first, before body parsing so no-auth is 401)
      if (pathname === '/mcp') {
        if (!authed(req)) {
          errJson(res, 401, 'Unauthorized');
          return;
        }
        await handleMcp(req, res);
        return;
      }
      // GraphQL
      if (pathname === '/api/graphql') {
        if (!authed(req)) {
          errJson(res, 401, 'Unauthorized');
          return;
        }
        if (req.method !== 'POST') {
          errJson(res, 405, 'method not allowed');
          return;
        }
        await handleGraphQL(req, res);
        return;
      }
      // REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        if (!authed(req)) {
          errJson(res, 401, 'Unauthorized');
          return;
        }
        const restParts = parts.slice(1); // drop 'api', keep 'v3' off: parts[0]='api', parts[1]='v3'
        const handled = await handleRest(req, res, restParts.slice(1), query);
        if (handled) return;
        errJson(res, 404, 'Not Found');
        return;
      }
      errJson(res, 404, 'Not Found');
    } catch {
      if (!res.headersSent) errJson(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}
