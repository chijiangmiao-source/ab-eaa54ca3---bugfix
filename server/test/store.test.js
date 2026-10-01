'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditStore } = require('../src/store');

const basePayload = () => ({
  auditId: 'AUDIT-001',
  constants: ['a', 'b'],
  functions: { f: 1 },
  steps: [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ],
});

test('有效证明裁决 equal 并冻结', () => {
  const store = new AuditStore();
  const { status, body } = store.submit(basePayload());
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.verdict, 'equal');
  assert.ok(body.payloadHash.length === 64);
  assert.equal(body.failure, null);
});

test('同标识同载荷重传：回放冻结结果', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload());
  const frozenAt = first.body.frozenAt;
  const second = store.submit(basePayload());
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.frozenAt, frozenAt);
  assert.equal(second.body.payloadHash, first.body.payloadHash);
});

test('同标识改换载荷：明确拒绝（409）且保留旧冻结结果', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload());
  const changed = basePayload();
  changed.steps = [{ op: 'claim', left: 'a', right: 'b' }];
  const rejected = store.submit(changed);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'PAYLOAD_CHANGED');
  assert.notEqual(rejected.body.frozenPayloadHash, rejected.body.receivedPayloadHash);
  // 旧证据未被覆盖
  const again = store.submit(basePayload());
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.verdict, 'equal');
});

test('失败证明：定位失败步骤并清除页面旧证据（accepted=false, trace 截断）', () => {
  const store = new AuditStore();
  const payload = basePayload();
  payload.steps = [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'a', right: 'f(a)' }, // 不成立
    { op: 'eq', left: 'a', right: 'f(a)' }, // 不应执行
  ];
  const { status, body } = store.submit(payload);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.verdict, 'rejected');
  assert.equal(body.failure.index, 1);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
  assert.equal(body.trace.length, 1); // 失败步及其后不进入轨迹
  assert.deepEqual(body.classes, []);
});

test('空栈弹出等结构性错误被定位到具体步骤', () => {
  const store = new AuditStore();
  const payload = basePayload();
  payload.steps = [{ op: 'push' }, { op: 'pop' }, { op: 'pop' }];
  const { body } = store.submit(payload);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 2);
  assert.equal(body.failure.code, 'EMPTY_STACK_POP');
});

test('未知符号 / 元数不符 / 超长轨迹在受理阶段拒绝', () => {
  const store = new AuditStore();
  let p = basePayload();
  p.auditId = 'X1';
  p.steps = [{ op: 'claim', left: 'a', right: 'z' }];
  assert.equal(store.submit(p).body.failure.code, 'UNKNOWN_SYMBOL');

  p = basePayload();
  p.auditId = 'X2';
  p.steps = [{ op: 'eq', left: 'f(a,b)', right: 'a' }];
  assert.equal(store.submit(p).body.failure.code, 'ARITY_MISMATCH');

  p = basePayload();
  p.auditId = 'X3';
  p.steps = Array.from({ length: 181 }, () => ({ op: 'push' }));
  assert.equal(store.submit(p).body.failure.code, 'TOO_MANY_STEPS');
});

test('失效作用域场景：pop 后声称失败被冻结记录', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'SCOPE-9';
  p.steps = [
    { op: 'push' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'pop' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ];
  const { body } = store.submit(p);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 3);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
});

// --- 冻结 / 重放 / 换载荷拒绝：步骤顺序是载荷语义的一部分 ----------------------

test('先通过后交换“声称/声明”次序：第二次必须冲突而非回放旧裁决，原记录不变', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload()); // eq a=b 然后 claim f(a)=f(b) —— 通过
  assert.equal(first.status, 200);
  assert.equal(first.body.verdict, 'equal');

  // 同一审计标识、相同声明集合，仅交换两个步骤的先后次序
  const reordered = basePayload();
  reordered.steps = [
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
    { op: 'eq', left: 'a', right: 'b' },
  ];
  const second = store.submit(reordered);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'PAYLOAD_CHANGED');
  assert.notEqual(second.body.receivedPayloadHash, second.body.frozenPayloadHash);
  assert.equal(second.body.verdict, undefined, '不得回放旧的通过裁决');

  // 原冻结记录：结论、冻结时间、轨迹均未改写
  const frozen = store.get('AUDIT-001');
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.verdict, 'equal');
  assert.equal(frozen.body.frozenAt, first.body.frozenAt);
  assert.equal(frozen.body.payloadHash, first.body.payloadHash);
  assert.deepEqual(
    frozen.body.trace.map((s) => s.op),
    ['eq', 'claim']
  );
  assert.deepEqual(
    frozen.body.steps.map((s) => s.op),
    ['eq', 'claim']
  );

  // 原载荷重传仍稳定回放
  const again = store.submit(basePayload());
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.frozenAt, first.body.frozenAt);
});

test('交换次序后的轨迹若换新标识提交：首条声称即不成立', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'AUDIT-002';
  p.steps = [
    { op: 'claim', left: 'f(a)', right: 'f(b)' }, // 首条声称：尚无 a=b，不成立
    { op: 'eq', left: 'a', right: 'b' },
  ];
  const { status, body } = store.submit(p);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.verdict, 'rejected');
  assert.equal(body.failure.index, 0);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
  assert.equal(body.trace.length, 0);
});

test('push/pop/eq/neq/claim 任意相对位置变化都视为换载荷（409）', () => {
  const mk = (id, steps) => ({ auditId: id, constants: ['a', 'b'], functions: { f: 1 }, steps });
  const base = [
    { op: 'push', label: 'L' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'neq', left: 'a', right: 'f(a)' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
    { op: 'pop', label: 'L' },
  ];
  const variants = [
    [base[1], base[0], base[2], base[3], base[4]], // 交换 push/eq
    [base[0], base[2], base[1], base[3], base[4]], // 交换 eq/neq
    [base[0], base[1], base[3], base[2], base[4]], // 交换 neq/claim
    [base[0], base[1], base[2], base[4], base[3]], // 交换 claim/pop
  ];
  for (const steps of variants) {
    const store = new AuditStore();
    const first = store.submit(mk('REORDER', base));
    assert.equal(first.status, 200);
    const second = store.submit(mk('REORDER', steps));
    assert.equal(second.status, 409, `步骤重排必须拒绝: ${JSON.stringify(steps.map((s) => s.op))}`);
    assert.equal(second.body.error, 'PAYLOAD_CHANGED');
    // 原记录未被改写
    assert.equal(store.get('REORDER').body.frozenAt, first.body.frozenAt);
  }
});

test('常量录入顺序、函数键顺序、步骤字段顺序、项空白差异：稳定回放同一冻结结果', () => {
  const store = new AuditStore();
  const first = store.submit({
    auditId: 'CANON-1',
    constants: ['a', 'b'],
    functions: { f: 1, g: 2 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
    ],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.verdict, 'equal');

  // 常量重排 + 函数键重排 + 步骤字段书写顺序不同 + 项空白差异
  const restyled = {
    auditId: 'CANON-1',
    constants: ['b', 'a'],
    functions: { g: 2, f: 1 },
    steps: [
      { right: ' b ', left: 'a', op: 'eq' },
      { right: 'f( b )', op: 'claim', left: ' f(a)' },
    ],
  };
  const second = store.submit(restyled);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.payloadHash, first.body.payloadHash);
  assert.equal(second.body.frozenAt, first.body.frozenAt);
  assert.equal(second.body.verdict, 'equal');
});

test('作用域标签文字、函数元数、项内容、业务步骤内容变化：均识别为不同载荷', () => {
  const mk = (id, mutate) => {
    const p = {
      auditId: id,
      constants: ['a', 'b'],
      functions: { f: 1 },
      steps: [
        { op: 'push', label: 'L' },
        { op: 'eq', left: 'a', right: 'b' },
        { op: 'claim', left: 'f(a)', right: 'f(b)' },
        { op: 'pop', label: 'L' },
      ],
    };
    mutate(p);
    return p;
  };
  const mutations = [
    (p) => (p.steps[0].label = 'L2'), // 作用域标签文字
    (p) => (p.steps[3].label = 'L2'), // pop 校验标签文字
    (p) => (p.functions.f = 2), // 函数元数
    (p) => (p.steps[2].left = 'f(b)'), // 项内容
    (p) => (p.steps[1].right = 'f(a)'), // 业务步骤内容
    (p) => p.steps.splice(3, 1), // 删除一步
    (p) => p.steps.push({ op: 'claim', left: 'a', right: 'a' }), // 新增一步
  ];
  for (const mutate of mutations) {
    const store = new AuditStore();
    const first = store.submit(mk('DISTINCT', () => {}));
    assert.equal(first.status, 200);
    const second = store.submit(mk('DISTINCT', mutate));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'PAYLOAD_CHANGED');
    assert.equal(store.get('DISTINCT').body.frozenAt, first.body.frozenAt);
  }
});

test('同层冲突：整步回滚并冻结驳回记录', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'CLASH-1';
  p.steps = [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'eq', left: 'a', right: 'b' },
  ];
  const { status, body } = store.submit(p);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 1);
  assert.equal(body.failure.code, 'SAME_LEVEL_CONFLICT');
  // 驳回同样冻结：同载荷重传回放
  const again = store.submit(p);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.failure.code, 'SAME_LEVEL_CONFLICT');
});
