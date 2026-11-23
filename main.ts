// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the four edit formats (unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits), line matching at three tiers, and the all-or-nothing write. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(from: string, to: string): void {
    this.moves.push({ from, to });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 3: a file as its line break, its lines, its final  */
/* line break.                                                        */
/* ------------------------------------------------------------------ */

interface FileData {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileData {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(d: FileData): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 5: matching lines at three tiers.                  */
/* ------------------------------------------------------------------ */

function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trailTrim(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return trailTrim(a).replace(/^[ \t]+/, '') === trailTrim(b).replace(/^[ \t]+/, '');
}

/** A line as the tier compares it: tier 0 the line itself, tier 1 without trailing
 *  spaces/tabs, tier 2 without leading and trailing spaces/tabs. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = trailTrim(s);
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions where O matches lines at the tier, in order; overlapping allowed.
 *  The tier's normal form of each line is computed once, so a long O against a long
 *  file costs O(L + k) trims instead of one trim per comparison. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const normLines = tier === 0 ? lines : lines.map((l) => normLine(l, tier));
  const normO = tier === 0 ? o : o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLines[i + j]! !== normO[j]!) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** As findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((q) => q >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after `from` equal to the single-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

type BodyLine = { kind: 'ctx' | 'old' | 'new'; text: string };

/** Split a hunk/chunk body into old lines O, new lines N, and for each line of N the index of the
 *  context line of O it is (-1 when it is not a context line). */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; nCtx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(e.text);
      n.push(e.text);
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      nCtx.push(-1);
      n.push(e.text);
    }
  }
  return { o, n, nCtx };
}

/** The lines N writes when it replaces O at position `pos`: context lines are the file's own matched
 *  lines; at tier 2 every other non-blank line starting with P (the leading spaces/tabs of O's first
 *  line) has that P replaced by F (the leading spaces/tabs of the file's first matched line). */
function buildNew(o: string[], n: string[], nCtx: number[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? lead(fileLines[pos]!) : '';
  const p = o.length > 0 ? lead(o[0]!) : '';
  for (let k = 0; k < n.length; k++) {
    const ci = nCtx[k]!;
    if (ci >= 0) {
      out.push(fileLines[pos + ci]!);
      continue;
    }
    const line = n[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 6: unified diffs.                                 */
/* ------------------------------------------------------------------ */

type UniBodyEntry =
  | { kind: 'ctx'; text: string; blank: boolean }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'mark' };

interface UniHunk {
  a: number;
  body: UniBodyEntry[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function parseDiffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A path as the section names it: '/dev/null' means no file. */
function normPath(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

/** A hunk body: the lines after the header, ending at the first other line, a `diff --git ` line,
 *  a `--- ` line followed by a `+++ ` line, or the end of the patch. Empty lines at the end of a
 *  body are not part of it. Returns the body and the index of the first line after it. */
function parseHunkBody(lines: string[], j: number): { body: UniBodyEntry[]; next: number } {
  const body: UniBodyEntry[] = [];
  const n = lines.length;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', blank: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), blank: false });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'mark' });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const e = body[body.length - 1]!;
    if (e.kind === 'ctx' && e.blank) body.pop();
    else break;
  }
  return { body, next: j };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastCtxOrNewHasMark(body: UniBodyEntry[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const e = body[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'mark';
}

/** Whether a `\` line follows the last `+` line of all the hunks, in order. */
function lastNewHasMark(hunks: UniHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    let lastNew = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k]!.kind === 'new') lastNew = k;
    }
    if (lastNew >= 0) return body[lastNew + 1]?.kind === 'mark';
  }
  return false;
}

function parseUnified(lines: string[]): UniSection[] {
  interface Raw {
    diffOld?: string | null;
    diffNew?: string | null;
    pairOld?: string | null;
    pairNew?: string | null;
    renFrom?: string | null;
    renTo?: string | null;
    create: boolean;
    del: boolean;
    hunks: UniHunk[];
  }
  const raws: Raw[] = [];
  const n = lines.length;
  let i = 0;
  let phase: 'between' | 'header' | 'hunks' = 'between';
  let cur: Raw | null = null;

  const startSection = (diffOld?: string | null, diffNew?: string | null): void => {
    cur = { diffOld, diffNew, create: false, del: false, hunks: [] };
    raws.push(cur);
    phase = 'header';
  };
  const parseDiffGit = (line: string, no: number): [string, string] => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${no}`);
    return [m[1]!, m[2]!];
  };
  const parseHunkAt = (idx: number): { hunk: UniHunk; next: number } => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[idx]!);
    if (!m) throw new Exit2(`error: parse ${idx + 1}`);
    const { body, next } = parseHunkBody(lines, idx + 1);
    return { hunk: { a: parseInt(m[1]!, 10), body }, next };
  };

  while (i < n) {
    const l = lines[i]!;
    if (phase === 'between') {
      if (l.startsWith('diff --git ')) {
        const [x, y] = parseDiffGit(l, i + 1);
        startSection(normPath(x), normPath(y));
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection();
        cur!.pairOld = normPath(stripAB(parseDiffPath(l)));
        cur!.pairNew = normPath(stripAB(parseDiffPath(lines[i + 1]!)));
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (phase === 'header') {
      if (l.startsWith('@@')) {
        const { hunk, next } = parseHunkAt(i);
        cur!.hunks.push(hunk);
        phase = 'hunks';
        i = next;
        continue;
      }
      if (l.startsWith('diff --git ')) {
        const [x, y] = parseDiffGit(l, i + 1);
        startSection(normPath(x), normPath(y));
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          // SPEC section 6: a `---`/`+++` pair in the header names the old and new path.
          // The header is everything before the first hunk, so a second pair is still
          // header content and names the paths again: the later pair wins.
          cur!.pairOld = normPath(stripAB(parseDiffPath(l)));
          cur!.pairNew = normPath(stripAB(parseDiffPath(lines[i + 1]!)));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        // As with the `---`/`+++` pair, a later rename line in the header names the
        // paths again: the later one wins (SPEC section 6 gives no "first" rule).
        cur!.renFrom = normPath(l.slice(12).trim());
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur!.renTo = normPath(l.slice(10).trim());
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur!.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur!.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // phase === 'hunks'
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunkAt(i);
      cur!.hunks.push(hunk);
      i = next;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(l, i + 1);
      startSection(normPath(x), normPath(y));
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection();
      cur!.pairOld = normPath(stripAB(parseDiffPath(l)));
      cur!.pairNew = normPath(stripAB(parseDiffPath(lines[i + 1]!)));
      i += 2;
      continue;
    }
    i++;
  }

  return raws.map((r) => {
    const oldPath =
      r.pairOld !== undefined ? r.pairOld : r.renFrom !== undefined ? r.renFrom : r.diffOld !== undefined ? r.diffOld : null;
    const newPath =
      r.pairNew !== undefined ? r.pairNew : r.renTo !== undefined ? r.renTo : r.diffNew !== undefined ? r.diffNew : null;
    return { oldPath, newPath, create: r.create, del: r.del, hunks: r.hunks };
  });
}

/** Apply one hunk to a file's lines. `d` is the sum of (N length minus O length) over this section's
 *  hunks applied so far. Returns the new file and the updated d. */
function applyHunk(fd: FileData, hunk: UniHunk, d: number, strict: boolean, path: string): { fd: FileData; d: number } {
  const bodyLines = hunk.body.filter((e) => e.kind !== 'mark') as BodyLine[];
  const { o, n, nCtx } = splitBody(bodyLines);
  const hasMark = lastCtxOrNewHasMark(hunk.body);
  if (o.length > 0) {
    const found = findTier(fd.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let bestDist = Math.abs(pos - target);
    for (const q of found.occ) {
      const dist = Math.abs(q - target);
      if (dist < bestDist) {
        pos = q;
        bestDist = dist;
      }
    }
    const repl = buildNew(o, n, nCtx, fd.lines, pos, found.tier);
    const lines = [...fd.lines.slice(0, pos), ...repl, ...fd.lines.slice(pos + o.length)];
    const touchedEnd = pos + o.length === fd.lines.length;
    const final = touchedEnd ? !hasMark : fd.final;
    return { fd: { br: fd.br, lines, final }, d: d + (n.length - o.length) };
  }
  const insertPos = Math.max(0, Math.min(hunk.a + d, fd.lines.length));
  const lines = [...fd.lines.slice(0, insertPos), ...n, ...fd.lines.slice(insertPos)];
  const touchedEnd = insertPos === fd.lines.length;
  const final = touchedEnd ? !hasMark : fd.final;
  return { fd: { br: fd.br, lines, final }, d: d + n.length };
}

function applyUniSection(tree: Tree, s: UniSection, strict: boolean): void {
  const isCreate = s.oldPath === null || s.create;
  const isDelete = !isCreate && (s.newPath === null || s.del);
  if (isCreate) {
    const np = s.newPath;
    if (np === null) throw new Fail('unsafe', '/dev/null');
    if (!safe(np)) throw new Fail('unsafe', np);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const plus: string[] = [];
    for (const h of s.hunks) {
      for (const e of h.body) if (e.kind === 'new') plus.push(e.text);
    }
    const hasMark = lastNewHasMark(s.hunks);
    tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (hasMark ? '' : '\n'));
    return;
  }
  if (isDelete) {
    const op = s.oldPath;
    if (op === null) throw new Fail('unsafe', '/dev/null');
    if (!safe(op)) throw new Fail('unsafe', op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, null);
    return;
  }
  const op = s.oldPath!;
  const np = s.newPath!;
  const isMove = op !== np;
  if (!safe(op)) throw new Fail('unsafe', op);
  if (isMove && !safe(np)) throw new Fail('unsafe', np);
  const before = tree.get(op);
  if (before === null) throw new Fail('missing', op);
  if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
  let fd = splitFile(before);
  let d = 0;
  for (const h of s.hunks) {
    const r = applyHunk(fd, h, d, strict, op);
    fd = r.fd;
    d = r.d;
  }
  const out = joinFile(fd);
  if (isMove) {
    tree.now.set(op, null);
    tree.now.set(np, out);
    tree.noteMove(op, np);
  } else {
    tree.now.set(op, out);
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree) => applyUniSection(tree, s, strict));
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 7: SEARCH/REPLACE blocks.                         */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks.map((b) => (tree: Tree) => applySRBlock(tree, b, strict));
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): void {
  const p = b.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return;
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  const fd = splitFile(before);
  const found = findTier(fd.lines, b.oldLines, strict);
  if (!found) throw new Fail('no-match', p);
  if (found.occ.length > 1) throw new Fail('ambiguous', p);
  const pos = found.occ[0]!;
  const repl = buildNew(b.oldLines, b.newLines, b.newLines.map(() => -1), fd.lines, pos, found.tier);
  const lines = [...fd.lines.slice(0, pos), ...repl, ...fd.lines.slice(pos + b.oldLines.length)];
  tree.now.set(p, joinFile({ br: fd.br, lines, final: fd.final }));
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 8: V4A patches.                                   */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'del' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
}

function parseV4ASection(kind: 'add' | 'del' | 'update', path: string, lineNo: number, raw: { text: string; no: number }[]): V4ASection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const { text, no } of raw) {
      if (text.startsWith('+')) addLines.push(text.slice(1));
      else if (text === '') addLines.push('');
      // SPEC section 8: an Add File line is a `+` line or an empty line. A line of
      // only whitespace is neither: section 4 defines "blank" as empty-or-whitespace,
      // so "empty" here means literally empty, and a whitespace-only line is a parse
      // error (unlike a blank line at the end of a section, which is not part of it).
      else throw new Exit2(`error: parse ${no}`);
    }
    return { kind, path, lineNo, addLines, moveTo: null, chunks: [] };
  }
  if (kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return { kind, path, lineNo, addLines: [], moveTo: null, chunks: [] };
  }
  let moveTo: string | null = null;
  let rest = raw;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice(13).trim();
    rest = rest.slice(1);
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let seen = false;
  for (const { text, no } of rest) {
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim() || null, eof: false, body: [] };
      seen = true;
      continue;
    }
    if (text.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    const c = text[0];
    if (text === '' || c === ' ' || c === '-' || c === '+') {
      const entry: BodyLine =
        text === '' ? { kind: 'ctx', text: '' } : { kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: text.slice(1) };
      if (cur === null) {
        if (seen) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, body: [entry] };
        seen = true;
      } else {
        cur.body.push(entry);
      }
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return { kind, path, lineNo, addLines: [], moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const lineNo = i + 1;
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ')) break;
      raw.push({ text: l2, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push(parseV4ASection(kind, path, lineNo, raw));
  }
  return sections.map((s) => (tree: Tree) => applyV4ASection(tree, s, strict));
}

function applyV4ASection(tree: Tree, s: V4ASection, strict: boolean): void {
  const p = s.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (s.kind === 'add') {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'del') {
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  let newP: string | null = null;
  if (s.moveTo !== null) {
    newP = s.moveTo;
    if (!safe(newP)) throw new Fail('unsafe', newP);
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  if (newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
  let fd = splitFile(before);
  let cursor = 0;
  for (const ch of s.chunks) {
    if (ch.anchor !== null) {
      const idx = findAnchor(fd.lines, ch.anchor, cursor, strict);
      if (idx < 0) throw new Fail('no-match', p);
      cursor = idx + 1;
    }
    const { o, n, nCtx } = splitBody(ch.body);
    if (o.length > 0) {
      const found = findTierFrom(fd.lines, o, cursor, strict);
      if (!found) throw new Fail('no-match', p);
      let pos = -1;
      if (ch.eof) {
        for (const q of found.occ) {
          if (q + o.length === fd.lines.length) {
            pos = q;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', p);
      } else {
        pos = found.occ[0]!;
      }
      const repl = buildNew(o, n, nCtx, fd.lines, pos, found.tier);
      fd = { br: fd.br, lines: [...fd.lines.slice(0, pos), ...repl, ...fd.lines.slice(pos + o.length)], final: fd.final };
      cursor = pos + repl.length;
    } else {
      const insertPos = ch.eof ? fd.lines.length : cursor;
      fd = { br: fd.br, lines: [...fd.lines.slice(0, insertPos), ...n, ...fd.lines.slice(insertPos)], final: fd.final };
      cursor = insertPos + n.length;
    }
  }
  const out = joinFile(fd);
  if (newP !== null) {
    tree.now.set(p, null);
    tree.now.set(newP, out);
    tree.noteMove(p, newP);
  } else {
    tree.now.set(p, out);
  }
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (UTF-8); a move that succeeded is one `R <old> -> <new>`
  // line sorting by <new>, replacing that pair's D and A lines.
  const dest = new Map<string, string>();
  for (const m of tree.moves) dest.set(m.from, m.to);
  const resolve = (p: string): string => {
    const seen = new Set<string>([p]);
    let cur = p;
    while (dest.has(cur)) {
      const nxt = dest.get(cur)!;
      if (seen.has(nxt)) break;
      seen.add(nxt);
      cur = nxt;
    }
    return cur;
  };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const from of [...new Set(tree.moves.map((m) => m.from))]) {
    const to = resolve(from);
    if (to === from) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      rOld.add(from);
      rNew.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    // Deletes first, so a directory can take the place of a file it replaces.
    for (const p of [...tree.now.keys()]) {
      if (tree.original(p) !== tree.now.get(p) && tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
