'use strict';

// ---------------------------------------------------------------------------
// Term model
//
//   { kind: 'const', name }              e.g.  a
//   { kind: 'app',   fn, args: Term[] }  e.g.  f(a, g(b))
//
// Terms are content-addressed in a global intern table.  Scope visibility is a
// separate concern: a PUSH copies all mutable tables and a POP restores them,
// so an equation (or inequality) derived inside a popped scope can never leak
// outward.  Structural applications seen only inside that scope are likewise
// removed with the snapshot and may be re-interned later.
// ---------------------------------------------------------------------------

class ProofError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ProofError';
    this.code = code;
    this.detail = detail || null;
  }
}

class Const {
  constructor(name) {
    this.kind = 'const';
    this.name = name;
  }
}
class App {
  constructor(fn, args) {
    this.kind = 'app';
    this.fn = fn;
    this.args = args;
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- string parser: f(a, b, g(c)) -------------------------------------------

function parseTermString(s) {
  if (typeof s !== 'string') throw new ProofError('BAD_TERM', `非法项: ${JSON.stringify(s)}`);
  const p = new Parser(s);
  const t = p.parseExpr();
  p.skipWs();
  if (!p.eof()) throw new ProofError('BAD_TERM', `项 "${s}" 位置 ${p.pos} 后存在多余字符`);
  return t;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.pos = 0;
  }
  eof() {
    return this.pos >= this.s.length;
  }
  skipWs() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }
  parseIdent() {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.s.length && /[A-Za-z0-9_]/.test(this.s[this.pos])) this.pos++;
    if (start === this.pos) {
      throw new ProofError('BAD_TERM', `项 "${this.s}" 位置 ${this.pos} 处应为标识符`);
    }
    return this.s.slice(start, this.pos);
  }
  parseExpr() {
    const head = this.parseIdent();
    this.skipWs();
    if (this.s[this.pos] !== '(') return new Const(head);
    this.pos++;
    const args = [];
    this.skipWs();
    if (this.s[this.pos] === ')') {
      this.pos++;
      return new App(head, args);
    }
    for (;;) {
      args.push(this.parseExpr());
      this.skipWs();
      const c = this.s[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ')') {
        this.pos++;
        return new App(head, args);
      }
      throw new ProofError('BAD_TERM', `项 "${this.s}" 位置 ${this.pos} 处应为 ',' 或 ')'`);
    }
  }
}

// ---------------------------------------------------------------------------
// ProofEngine: rollback congruence closure.
//
// Snapshot strategy (at most 180 steps, so copying tables is cheap and makes
// leakage of inner facts structurally impossible):
//   PUSH -> copy all mutable state
//   POP  -> restore the copy
//
// Union-find edges carry a reason (declared equality at step s / scope d, or
// congruence derived from such equations).  After every equality the closure
// is saturated: applications are grouped by fn + current argument roots and
// representatives from distinct classes are merged to a fixpoint.
//
// Same-level vs cross-level contradictions:
//   * merging two classes separated by an inequality declared at the SAME or
//     deeper scope is a SAME_LEVEL_CONFLICT — the whole step is rolled back;
//   * an inner-scope equality contradicting an OUTER inequality is the legal
//     reductio-assumption shape: the inequality is flagged as contradicted and
//     a later claim reports verdict "contradiction".  The flag vanishes on pop.
// ---------------------------------------------------------------------------

class ProofEngine {
  constructor(constants, functions) {
    this.declaredConstants = new Set();
    this.functions = Object.create(null);

    for (const c of constants) {
      if (typeof c !== 'string' || !IDENT_RE.test(c)) {
        throw new ProofError('BAD_TERM', `非法常量名: ${JSON.stringify(c)}`);
      }
      if (this.declaredConstants.has(c)) {
        throw new ProofError('BAD_TERM', `常量重复声明: ${c}`);
      }
      this.declaredConstants.add(c);
    }
    for (const fn of Object.keys(functions)) {
      if (!IDENT_RE.test(fn)) throw new ProofError('BAD_TERM', `非法函数名: ${fn}`);
      const arity = functions[fn];
      if (!Number.isInteger(arity) || arity < 0) {
        throw new ProofError('BAD_TERM', `函数 ${fn} 元数非法: ${arity}`);
      }
      this.functions[fn] = arity;
    }

    this._resetTables();
    for (const name of this.declaredConstants) this._internConst(name);

    this.scopeDepth = 0;
    this.checkpoints = []; // { label, snapshot }
    this.inequalities = []; // { a, b, scope, step, left, right, contradictedStep }
  }

  _resetTables() {
    this.nextId = 1;
    this.termKey = new Map(); // 'c:name' / 'a:fn(id,..)' -> termId
    this.terms = [null]; // termId -> Const | App
    this.appIds = []; // ids of interned applications
    this.parent = [0];
    this.rank = [0];
    this.why = [null]; // child termId -> { child, parent, reason }
  }

  // -- interning -------------------------------------------------------------

  _alloc(term) {
    const id = this.nextId++;
    this.terms[id] = term;
    this.parent[id] = id;
    this.rank[id] = 0;
    this.why[id] = null;
    return id;
  }

  _internConst(name) {
    const key = `c:${name}`;
    let id = this.termKey.get(key);
    if (id === undefined) {
      id = this._alloc(new Const(name));
      this.termKey.set(key, id);
    }
    return id;
  }

  _internApp(fn, argIds) {
    const key = `a:${fn}(${argIds.join(',')})`;
    let id = this.termKey.get(key);
    if (id === undefined) {
      id = this._alloc(new App(fn, argIds.slice()));
      this.termKey.set(key, id);
      this.appIds.push(id);
    }
    return id;
  }

  resolve(input) {
    const term = typeof input === 'string' ? parseTermString(input) : input;
    return this._resolve(term);
  }

  _resolve(term) {
    if (term.kind === 'const') {
      if (!this.declaredConstants.has(term.name)) {
        throw new ProofError('UNKNOWN_SYMBOL', `未知常量符号: ${term.name}`);
      }
      return this._internConst(term.name);
    }
    if (term.kind === 'app') {
      const arity = this.functions[term.fn];
      if (arity === undefined) {
        throw new ProofError('UNKNOWN_SYMBOL', `未知函数符号: ${term.fn}`);
      }
      if (term.args.length !== arity) {
        throw new ProofError(
          'ARITY_MISMATCH',
          `函数 ${term.fn} 元数为 ${arity}, 实参个数为 ${term.args.length}`
        );
      }
      return this._internApp(term.fn, term.args.map((a) => this._resolve(a)));
    }
    throw new ProofError('BAD_TERM', '非法的项种类');
  }

  // -- snapshot / rollback ---------------------------------------------------

  _snapshot() {
    return {
      nextId: this.nextId,
      termKey: new Map(this.termKey),
      terms: this.terms.slice(),
      appIds: this.appIds.slice(),
      parent: this.parent.slice(),
      rank: this.rank.slice(),
      why: this.why.slice(),
      inequalities: this.inequalities.map((r) => ({ ...r })),
    };
  }

  _restore(s) {
    this.nextId = s.nextId;
    this.termKey = s.termKey;
    this.terms = s.terms;
    this.appIds = s.appIds;
    this.parent = s.parent;
    this.rank = s.rank;
    this.why = s.why;
    this.inequalities = s.inequalities;
  }

  // -- union-find ------------------------------------------------------------

  find(id) {
    let root = id;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = id;
    while (this.parent[cur] !== root) {
      const nxt = this.parent[cur];
      this.parent[cur] = root;
      cur = nxt;
    }
    return root;
  }

  _union(x, y, reason) {
    let rx = this.find(x);
    let ry = this.find(y);
    if (rx === ry) return null;
    if (this.rank[rx] < this.rank[ry]) {
      const t = rx;
      rx = ry;
      ry = t;
    }
    this.parent[ry] = rx;
    this.why[ry] = { child: ry, parent: rx, reason };
    if (this.rank[rx] === this.rank[ry]) this.rank[rx]++;
    return { root: rx };
  }

  // Guarded merge against inequalities.  Returns null (already equal),
  // { clash } (same-level conflict) or the union result.  Cross-level
  // contradictions are flagged on the inequality record.
  _mergeGuarded(a, b, reason, depth, stepIndex) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return null;
    for (const neq of this.inequalities) {
      const x = this.find(neq.a);
      const y = this.find(neq.b);
      const separates = (x === ra && y === rb) || (x === rb && y === ra);
      if (!separates) continue;
      if (neq.scope >= depth) return { clash: neq };
      if (neq.contradictedStep === null || neq.contradictedStep === undefined) {
        neq.contradictedStep = stepIndex;
      }
    }
    return this._union(a, b, reason);
  }

  // -- justification attribution ---------------------------------------------

  // BFS over union edges; returns the max (step, scope) among the edges on a
  // path connecting two equal terms.  A congruence merge of f(x),f(y) is
  // attributed to the equations that made each pair of arguments congruent.
  _pathInfo(x, y) {
    const adj = new Map();
    const add = (u, v, r) => {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push([v, r]);
    };
    for (let id = 1; id < this.nextId; id++) {
      const rec = this.why[id];
      if (!rec) continue;
      add(rec.child, rec.parent, rec.reason);
      add(rec.parent, rec.child, rec.reason);
    }
    const prev = new Map([[x, null]]);
    const queue = [x];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === y) break;
      for (const [to, r] of adj.get(cur) || []) {
        if (!prev.has(to)) {
          prev.set(to, [cur, r]);
          queue.push(to);
        }
      }
    }
    if (!prev.has(y) || x === y) return { maxStep: -1, maxScope: -1 };
    let maxStep = -1;
    let maxScope = -1;
    let cur = y;
    while (cur !== x) {
      const [from, r] = prev.get(cur);
      maxStep = Math.max(maxStep, r.step);
      maxScope = Math.max(maxScope, r.scope);
      cur = from;
    }
    return { maxStep, maxScope };
  }

  _congruenceVia(idA, idB) {
    const ta = this.terms[idA];
    const tb = this.terms[idB];
    return ta.args.map((argA, i) => ({
      arg: this.render(argA),
      congruentTo: this.render(tb.args[i]),
    }));
  }

  // Group applications by fn + argument roots.  Distinct classes sharing a key
  // are congruent; return merge descriptors for each such pair.
  _congruencePairs() {
    const groups = new Map();
    for (const appId of this.appIds) {
      const t = this.terms[appId];
      const key = `${t.fn}(${t.args.map((arg) => this.find(arg)).join(',')})`;
      let byRoot = groups.get(key);
      if (!byRoot) {
        byRoot = new Map();
        groups.set(key, byRoot);
      }
      byRoot.set(this.find(appId), appId);
    }
    const pairs = [];
    for (const [key, byRoot] of groups) {
      if (byRoot.size <= 1) continue;
      const reps = [...byRoot.values()];
      const anchor = reps[0];
      for (let i = 1; i < reps.length; i++) {
        const other = reps[i];
        if (this.find(anchor) === this.find(other)) continue;
        let step = -1;
        let scope = -1;
        const ta = this.terms[anchor];
        const tb = this.terms[other];
        for (let k = 0; k < ta.args.length; k++) {
          const info = this._pathInfo(ta.args[k], tb.args[k]);
          step = Math.max(step, info.maxStep);
          scope = Math.max(scope, info.maxScope);
        }
        pairs.push([
          anchor,
          other,
          {
            type: 'congruence',
            step: step < 0 ? 0 : step,
            scope: scope < 0 ? 0 : scope,
            key,
            aId: anchor,
            bId: other,
            via: this._congruenceVia(anchor, other),
          },
        ]);
      }
    }
    return pairs;
  }

  // Saturate congruence closure, optionally starting from a declared equality.
  // Same-level clashes reached even purely by propagation abort the saturation
  // and the caller rolls the whole step back.
  _saturate(seed, depth, stepIndex) {
    const propagation = [];
    const work = seed ? [seed] : [];
    // Applications may have been interned after their arguments became equal:
    // seed the worklist with every currently valid congruence pair.
    for (const pair of this._congruencePairs()) work.push(pair);

    while (work.length) {
      const [a, b, reason] = work.pop();
      const result = this._mergeGuarded(a, b, reason, depth, stepIndex);
      if (!result) continue;
      if (result.clash) return { ok: false, clash: result.clash, propagation };
      if (reason.type === 'congruence') {
        propagation.push({
          a: this.render(reason.aId),
          b: this.render(reason.bId),
          key: reason.key,
          via: reason.via,
          step: reason.step,
          scope: reason.scope,
        });
      }
      for (const pair of this._congruencePairs()) {
        if (this.find(pair[0]) !== this.find(pair[1])) work.push(pair);
      }
    }
    return { ok: true, propagation };
  }

  // Re-derive consequences of existing equations over newly interned terms.
  // Used after a neq/claim step introduces applications not seen before.
  _closeOver(stepIndex, depth) {
    return this._saturate(null, depth, stepIndex);
  }

  // -- contradiction inspection ----------------------------------------------

  liveContradiction() {
    for (const neq of this.inequalities) {
      if (this.find(neq.a) === this.find(neq.b)) {
        return {
          left: neq.left,
          right: neq.right,
          inequalityStep: neq.step,
          equalityStep: neq.contradictedStep,
          scope: neq.scope,
        };
      }
    }
    return null;
  }

  // -- rendering -------------------------------------------------------------

  render(id) {
    const t = this.terms[id];
    if (t.kind === 'const') return t.name;
    return `${t.fn}(${t.args.map((a) => this.render(a)).join(', ')})`;
  }

  classes() {
    const rootOf = new Map();
    for (let id = 1; id < this.nextId; id++) {
      const r = this.find(id);
      if (!rootOf.has(r)) rootOf.set(r, []);
      rootOf.get(r).push(this.render(id));
    }
    return [...rootOf.values()]
      .map((members) => members.sort())
      .sort((a, b) => a[0].localeCompare(b[0]));
  }

  // Expand the justification chain proving x ~ y.  Each congruence edge is
  // followed by the declaration/congruence edges on the paths connecting its
  // paired arguments, so an auditor can expand *both* the propagation step and
  // the equations it rests on.
  explain(x, y) {
    const adj = new Map();
    const link = (u, v, rec) => {
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u).push([v, rec]);
      adj.get(v).push([u, rec]);
    };
    for (let id = 1; id < this.nextId; id++) {
      const rec = this.why[id];
      if (rec) link(rec.child, rec.parent, rec);
    }

    const findPath = (from, to) => {
      const prev = new Map([[from, null]]);
      const queue = [from];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === to) break;
        for (const [nxt, rec] of adj.get(cur) || []) {
          if (!prev.has(nxt)) {
            prev.set(nxt, [cur, rec]);
            queue.push(nxt);
          }
        }
      }
      if (!prev.has(to)) return null;
      const edges = [];
      let cur = to;
      while (cur !== from) {
        const [, rec] = prev.get(cur);
        edges.push(rec);
        cur = rec.child === cur ? rec.parent : rec.child;
      }
      return edges;
    };

    const main = findPath(x, y);
    if (!main) return null;

    const chain = [];
    const seen = new Set();
    const pushEdge = (rec, supports) => {
      const key = `${rec.child}-${rec.parent}-${rec.reason.step}-${supports ? 's' : 'm'}`;
      if (seen.has(key)) return;
      seen.add(key);
      const rendered = this._renderReason(rec);
      if (supports) rendered.supportsCongruence = true;
      chain.push(rendered);
    };

    for (const rec of main) {
      pushEdge(rec, false);
      if (rec.reason.type === 'congruence') {
        const ta = this.terms[rec.reason.aId];
        const tb = this.terms[rec.reason.bId];
        for (let k = 0; k < ta.args.length; k++) {
          const sub = findPath(ta.args[k], tb.args[k]);
          if (sub) for (const subRec of sub) pushEdge(subRec, true);
        }
      }
    }
    return chain;
  }

  _renderReason(rec) {
    const r = rec.reason;
    const edge = {
      left: this.render(rec.child),
      right: this.render(rec.parent),
      kind: r.type === 'declared' ? 'declared' : 'congruence',
      step: r.step,
      scope: r.scope,
    };
    if (r.type === 'congruence') {
      edge.function = this.terms[r.aId].fn;
      edge.matchedArguments = r.via;
    }
    return edge;
  }

  // -- step processing -------------------------------------------------------

  process(step, index) {
    if (!step || typeof step !== 'object') {
      throw new ProofError('BAD_STEP', `步骤 ${index}: 格式非法，应为对象`);
    }
    const op = step.op;

    if (op === 'push') {
      const label = step.label === undefined ? null : String(step.label);
      this.checkpoints.push({ label, snapshot: this._snapshot() });
      this.scopeDepth++;
      return {
        index,
        op: 'push',
        label,
        accepted: true,
        scopeDepth: this.scopeDepth,
        detail: `进入第 ${this.scopeDepth} 层局部作用域${label ? `（${label}）` : ''}`,
      };
    }

    if (op === 'pop') {
      if (this.scopeDepth === 0) {
        throw new ProofError('EMPTY_STACK_POP', `步骤 ${index}: 作用域栈为空，不能弹出`);
      }
      const top = this.checkpoints[this.checkpoints.length - 1];
      if (step.label !== undefined && top.label !== String(step.label)) {
        throw new ProofError(
          'OUT_OF_SCOPE',
          `步骤 ${index}: 不能跨作用域关闭 "${step.label}"，栈顶为 ${
            top.label === null ? '未命名作用域' : `"${top.label}"`
          }`
        );
      }
      const poppedDepth = this.scopeDepth;
      const poppedLabel = top.label;
      this.checkpoints.pop();
      this._restore(top.snapshot);
      this.scopeDepth = poppedDepth - 1;
      return {
        index,
        op: 'pop',
        label: poppedLabel,
        accepted: true,
        scopeDepth: this.scopeDepth,
        detail: `退出第 ${poppedDepth} 层局部作用域${poppedLabel ? `（${poppedLabel}）` : ''}，内层事实已全部回滚`,
      };
    }

    if (op === 'eq' || op === 'neq') {
      if (typeof step.left !== 'string' || typeof step.right !== 'string') {
        throw new ProofError('BAD_TERM', `步骤 ${index}: 等式两侧必须是项字符串`);
      }
      const lId = this.resolve(step.left);
      const rId = this.resolve(step.right);

      if (op === 'neq') {
        // Close over any pre-existing congruences of the freshly interned terms
        // before judging whether the two sides are already equal.
        this._closeOver(index, this.scopeDepth);
        if (this.find(lId) === this.find(rId)) {
          const chain = this.explain(lId, rId) || [];
          // Legal reductio: equality rests solely on OUTER scope merges.
          const sameLevel =
            this.scopeDepth === 0 || chain.some((e) => e.scope >= this.scopeDepth);
          if (sameLevel) {
            throw new ProofError(
              'SAME_LEVEL_CONFLICT',
              `步骤 ${index}: 同层冲突——${step.left} 与 ${step.right} 已在当前作用域等价，不能再声明不等`,
              { chain }
            );
          }
        }
        const outerEqual = this.find(lId) === this.find(rId);
        const eqStep = outerEqual
          ? Math.max(...(this.explain(lId, rId) || []).map((e) => e.step))
          : null;
        this.inequalities.push({
          a: lId,
          b: rId,
          scope: this.scopeDepth,
          step: index,
          left: step.left,
          right: step.right,
          contradictedStep: eqStep,
        });
        return {
          index,
          op: 'neq',
          accepted: true,
          scopeDepth: this.scopeDepth,
          left: step.left,
          right: step.right,
          contradiction: outerEqual ? this.liveContradiction() : null,
          detail: outerEqual
            ? `在第 ${this.scopeDepth} 层假设 ${step.left} ≠ ${step.right}，与外层等式构成矛盾（反证法）`
            : `声明不等式 ${step.left} ≠ ${step.right}（第 ${this.scopeDepth} 层）`,
        };
      }

      const alreadyEqual = this.find(lId) === this.find(rId);
      const snap = this._snapshot();
      const result = this._saturate(
        [lId, rId, { type: 'declared', step: index, scope: this.scopeDepth }],
        this.scopeDepth,
        index
      );
      if (!result.ok) {
        this._restore(snap);
        const c = result.clash;
        throw new ProofError(
          'SAME_LEVEL_CONFLICT',
          `步骤 ${index}: 同层冲突——${step.left} = ${step.right} 与第 ${c.step} 步在同一作用域（第 ${c.scope} 层）声明的不等式 ${c.left} ≠ ${c.right} 冲突`,
          { inequalityStep: c.step, left: c.left, right: c.right }
        );
      }
      const contradiction = this.liveContradiction();
      return {
        index,
        op: 'eq',
        accepted: true,
        scopeDepth: this.scopeDepth,
        left: step.left,
        right: step.right,
        alreadyEqual,
        propagation: result.propagation,
        contradiction,
        detail: alreadyEqual
          ? `${step.left} = ${step.right} 已在同余闭包中成立`
          : `声明 ${step.left} = ${step.right}，同余传播新增 ${result.propagation.length} 条`,
      };
    }

    if (op === 'claim') {
      if (typeof step.left !== 'string' || typeof step.right !== 'string') {
        throw new ProofError('BAD_TERM', `步骤 ${index}: 声称两侧必须是项字符串`);
      }
      const lId = this.resolve(step.left);
      const rId = this.resolve(step.right);
      // A claim makes no new assertion, but newly mentioned applications still
      // participate in congruences that existing equations already justify.
      this._closeOver(index, this.scopeDepth);
      if (this.find(lId) !== this.find(rId)) {
        throw new ProofError(
          'CLAIM_FAILED',
          `步骤 ${index}: 声称不成立——当前作用域内 ${step.left} 与 ${step.right} 不等价`,
          { left: step.left, right: step.right, scopeDepth: this.scopeDepth }
        );
      }
      const contradiction = this.liveContradiction();
      return {
        index,
        op: 'claim',
        accepted: true,
        verdict: contradiction ? 'contradiction' : 'equal',
        scopeDepth: this.scopeDepth,
        left: step.left,
        right: step.right,
        evidence: this.explain(lId, rId),
        contradiction,
        detail: contradiction
          ? `声称成立，并确认矛盾：${contradiction.left} 与 ${contradiction.right} 既在第 ${contradiction.equalityStep} 步被合并，又在第 ${contradiction.inequalityStep} 步被声明不等`
          : `声称成立：${step.left} = ${step.right}，依据可逐条展开`,
      };
    }

    throw new ProofError('BAD_OP', `步骤 ${index}: 未知操作类型 "${op}"`);
  }
}

function createEngine({ constants = [], functions = {} } = {}) {
  return new ProofEngine(constants, functions);
}

module.exports = { ProofEngine, createEngine, ProofError, parseTermString, Const, App };
