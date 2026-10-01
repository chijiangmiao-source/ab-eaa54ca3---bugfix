'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, ProofError } = require('../src/engine');

function run(constants, functions, steps) {
  const eng = createEngine({ constants, functions });
  const trace = [];
  let failure = null;
  for (let i = 0; i < steps.length; i++) {
    try {
      trace.push(eng.process(steps[i], i));
    } catch (err) {
      if (err.index === undefined) err.index = i;
      failure = err;
      break;
    }
  }
  return { eng, trace, failure };
}

const expectFail = (res, code) => {
  assert.ok(res.failure instanceof ProofError, '应当抛出 ProofError');
  assert.equal(res.failure.code, code, `错误码应为 ${code}，实际 ${res.failure.code}`);
};

// --- 有效等式与同余传播 -------------------------------------------------------

test('同余闭包：实参等价才合并函数应用，并传播', () => {
  const { eng, failure } = run(['a', 'b', 'c'], { f: 1, g: 1 }, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ]);
  assert.equal(failure, null);
  // f(a) 与 f(b) 因同余合并
  assert.ok(eng.classes().some((c) => c.includes('f(a)') && c.includes('f(b)')));
});

test('相同函数应用在实参不等价时绝不合并', () => {
  const { eng } = run(['a', 'b'], { f: 1 }, []);
  eng.process({ op: 'eq', left: 'f(a)', right: 'f(a)' }, 0); // 自身，平凡
  // f(a) 与 f(b) 必须在不同等价类
  const classes = eng.classes();
  const ca = classes.find((c) => c.includes('f(a)'));
  const cb = classes.find((c) => c.includes('f(b)'));
  assert.notDeepEqual(ca, cb);
  assert.ok(!ca.includes('f(b)'));
});

test('二元函数：逐实参同余，链式传播到嵌套项', () => {
  const { eng, failure, trace } = run(['a', 'b', 'c', 'd'], { h: 2, k: 1 }, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'eq', left: 'c', right: 'd' },
    { op: 'claim', left: 'h(a,c)', right: 'h(b,d)' },
    { op: 'claim', left: 'k(h(a,c))', right: 'k(h(b,d))' },
  ]);
  assert.equal(failure, null);
  assert.equal(trace[2].verdict, 'equal');
  assert.equal(trace[3].verdict, 'equal');
  assert.ok(eng.classes().some((c) => c.includes('h(a, c)') && c.includes('h(b, d)')));
  assert.ok(eng.classes().some((c) => c.includes('k(h(a, c))') && c.includes('k(h(b, d))')));
});

test('claim 返回可展开的声明与同余依据', () => {
  const { trace } = run(['a', 'b'], { f: 1 }, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ]);
  const claim = trace.find((s) => s.op === 'claim');
  assert.equal(claim.verdict, 'equal');
  assert.ok(Array.isArray(claim.evidence) && claim.evidence.length >= 1);
  const kinds = claim.evidence.map((e) => e.kind);
  assert.ok(kinds.includes('declared'));
  assert.ok(kinds.includes('congruence'));
  const cong = claim.evidence.find((e) => e.kind === 'congruence');
  assert.equal(cong.function, 'f');
  assert.ok(cong.matchedArguments.some((m) => m.arg === 'a' && m.congruentTo === 'b'));
});

// --- 失效作用域：pop 后内层事实不残留 ----------------------------------------

test('pop 回滚内层等式，外层 claim 必须失败', () => {
  const res = run(['a', 'b'], { f: 1 }, [
    { op: 'push' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
    { op: 'pop' },
    { op: 'claim', left: 'a', right: 'b' }, // 已失效
  ]);
  expectFail(res, 'CLAIM_FAILED');
  assert.equal(res.failure.index, 4);
  // 闭包中不得残留内层合并
  const classes = res.eng.classes();
  assert.ok(!classes.some((c) => c.includes('a') && c.includes('b')));
});

test('外层等式穿透到内层，内层等式不泄漏到外层', () => {
  const res = run(['a', 'b', 'c'], { f: 1 }, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'push' },
    { op: 'eq', left: 'b', right: 'c' },
    { op: 'claim', left: 'a', right: 'c' },
    { op: 'pop' },
  ]);
  assert.equal(res.failure, null);
  const classes = res.eng.classes();
  assert.ok(classes.some((c) => c.includes('a') && c.includes('b')));
  assert.ok(!classes.some((c) => c.includes('b') && c.includes('c')));
});

// --- 冲突与回退 ---------------------------------------------------------------

test('同层先 eq 再 neq：拒绝且不改变状态', () => {
  const res = run(['a', 'b'], {}, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'neq', left: 'a', right: 'b' },
  ]);
  expectFail(res, 'SAME_LEVEL_CONFLICT');
  // 第一条等式仍在
  assert.ok(res.eng.classes().some((c) => c.includes('a') && c.includes('b')));
  // 没有留下任何不等式
  assert.equal(res.eng.inequalities.length, 0);
});

test('同层 neq 之后 eq：拒绝并整体回滚该等式（含其同余传播）', () => {
  const res = run(['a', 'b', 'c'], { f: 1 }, [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'eq', left: 'a', right: 'b' }, // 应失败回滚
    { op: 'claim', left: 'f(a)', right: 'f(b)' }, // 因而不成立
  ]);
  expectFail(res, 'SAME_LEVEL_CONFLICT');
  assert.equal(res.failure.index, 1);
  // 换一个全新引擎验证回滚后 f(a) 与 f(b) 仍不同类（先把两项驻留进闭包）
  const check = run(['a', 'b', 'c'], { f: 1 }, [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(a)' },
    { op: 'claim', left: 'f(b)', right: 'f(b)' },
  ]);
  const cls = check.eng.classes();
  const ca = cls.find((c) => c.includes('f(a)'));
  assert.ok(!ca.includes('f(b)'));
});

test('跨层矛盾（反证法）允许：内层不等假设 vs 外层等式，pop 后消失', () => {
  const res = run(['a', 'b'], {}, [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'push' },
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'claim', left: 'a', right: 'b' },
    { op: 'pop' },
  ]);
  assert.equal(res.failure, null);
  const claim = res.trace.find((s) => s.op === 'claim');
  assert.equal(claim.verdict, 'contradiction');
  assert.ok(claim.contradiction);
  // pop 后矛盾与内层不等式都消失
  assert.equal(res.eng.liveContradiction(), null);
  assert.equal(res.eng.inequalities.length, 0);
  // 外层等式仍然成立
  assert.ok(res.eng.classes().some((c) => c.includes('a') && c.includes('b')));
});

test('内层 eq 与外层 neq 构成跨层矛盾，同层 eq 则拒绝', () => {
  // 外层 neq，内层假设 eq => 合法矛盾
  const ok = run(['a', 'b'], {}, [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'push' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'a', right: 'b' },
    { op: 'pop' },
  ]);
  assert.equal(ok.failure, null);
  assert.equal(ok.trace.find((s) => s.op === 'claim').verdict, 'contradiction');
  assert.equal(ok.eng.liveContradiction(), null);

  // 同层 neq 后同层 eq => 拒绝
  const bad = run(['a', 'b'], {}, [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'eq', left: 'a', right: 'b' },
  ]);
  expectFail(bad, 'SAME_LEVEL_CONFLICT');
});

// --- 非法操作定位 -------------------------------------------------------------

test('空栈弹出：EMPTY_STACK_POP', () => {
  const res = run([], {}, [{ op: 'pop' }]);
  expectFail(res, 'EMPTY_STACK_POP');
});

test('跨作用域关闭标签不符：OUT_OF_SCOPE', () => {
  const res = run([], {}, [
    { op: 'push', label: 'L1' },
    { op: 'push', label: 'L2' },
    { op: 'pop', label: 'L1' },
  ]);
  expectFail(res, 'OUT_OF_SCOPE');
});

test('未知符号与元数不符被定位', () => {
  const r1 = run(['a'], { f: 1 }, [{ op: 'claim', left: 'x', right: 'a' }]);
  expectFail(r1, 'UNKNOWN_SYMBOL');
  const r2 = run(['a', 'b'], { f: 1 }, [{ op: 'claim', left: 'f(a,b)', right: 'a' }]);
  expectFail(r2, 'ARITY_MISMATCH');
  const r3 = run(['a'], {}, [{ op: 'eq', left: 'g(a)', right: 'a' }]);
  expectFail(r3, 'UNKNOWN_SYMBOL');
});

test('未知操作类型：BAD_OP', () => {
  const res = run([], {}, [{ op: 'explode' }]);
  expectFail(res, 'BAD_OP');
});

test('首条不成立的声称即停止轨迹', () => {
  const res = run(['a', 'b'], {}, [
    { op: 'claim', left: 'a', right: 'b' },
    { op: 'eq', left: 'a', right: 'b' },
  ]);
  expectFail(res, 'CLAIM_FAILED');
  assert.equal(res.failure.index, 0);
  assert.equal(res.trace.length, 0);
});
