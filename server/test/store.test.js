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

// --- 稳定标识：只能回放语义未变的载荷 ----------------------------------------

test('重放攻击：claim 提前于 eq 的重排必须 409，不得回放旧通过裁决', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload());
  assert.equal(first.status, 200);
  assert.equal(first.body.verdict, 'equal');
  const frozenAt = first.body.frozenAt;
  const frozenHash = first.body.payloadHash;
  const frozenSteps = first.body.steps.map((s) => s.op);

  // 同一审计标识、同一“声明集合”，仅交换 声称/声明 的先后次序。
  const reordered = basePayload();
  reordered.steps = [
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
    { op: 'eq', left: 'a', right: 'b' },
  ];
  const second = store.submit(reordered);
  assert.equal(second.status, 409, '重排轨迹必须按同标识异载荷拒绝');
  assert.equal(second.body.error, 'PAYLOAD_CHANGED');
  assert.equal(second.body.auditId, 'AUDIT-001');
  assert.equal(second.body.frozenPayloadHash, frozenHash);
  assert.notEqual(second.body.frozenPayloadHash, second.body.receivedPayloadHash);

  // 原冻结记录（结论 / 冻结时间 / 轨迹顺序）一律不得改写。
  const fetched = store.get('AUDIT-001');
  assert.equal(fetched.body.verdict, 'equal');
  assert.equal(fetched.body.accepted, true);
  assert.equal(fetched.body.frozenAt, frozenAt);
  assert.deepEqual(
    fetched.body.steps.map((s) => s.op),
    frozenSteps
  );
});

test('重排后的轨迹独立提交：首条声称即不成立（CLAIM_FAILED 定位第 0 步）', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'AUDIT-REORDER-FRESH';
  p.steps = [
    { right: 'f(b)', left: 'f(a)', op: 'claim' }, // 字段书写顺序也打乱
    { right: 'b', op: 'eq', left: 'a' },
  ];
  const { status, body } = store.submit(p);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 0);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
  assert.equal(body.trace.length, 0); // 首条声称失败即截断
});

test('push/pop 相对位置改变同样构成异载荷', () => {
  const store = new AuditStore();
  const p1 = basePayload();
  p1.auditId = 'AUDIT-MOVE-PUSH';
  p1.steps = [
    { op: 'push', label: '内层' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'pop', label: '内层' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' }, // 外层不成立
  ];
  assert.equal(store.submit(p1).body.accepted, false);

  const p2 = basePayload();
  p2.auditId = 'AUDIT-MOVE-PUSH';
  p2.steps = [
    { op: 'eq', left: 'a', right: 'b' }, // 等式移到 push 之前
    { op: 'push', label: '内层' },
    { op: 'pop', label: '内层' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ];
  const conflict = store.submit(p2);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'PAYLOAD_CHANGED');
});

test('等式改不等式（步骤内容变化）构成异载荷', () => {
  const store = new AuditStore();
  store.submit(basePayload());
  const p = basePayload();
  p.steps = [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ];
  assert.equal(store.submit(p).status, 409);
});

test('语义等价重传稳定回放：常量录入顺序、函数键顺序、字段顺序、项空白', () => {
  const store = new AuditStore();
  const first = store.submit({
    auditId: 'STABLE-001',
    constants: ['a', 'b'],
    functions: { f: 1, g: 2 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
      { op: 'push', label: '内层' },
      { op: 'eq', left: 'g(a, b)', right: 'g(b, a)' },
      { op: 'pop', label: '内层' },
    ],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, true);

  // 同一份证明的“换皮”重传：
  //  - 常量录入顺序反转；functions 键顺序反转；
  //  - 步骤对象字段书写顺序打乱；
  //  - 项字符串加入不改变解析结果的空白。
  const reskinned = {
    functions: { g: 2, f: 1 },
    constants: ['b', 'a'],
    auditId: 'STABLE-001',
    steps: [
      { right: 'b', left: 'a', op: 'eq' },
      { right: ' f( b ) ', left: 'f( a )', op: 'claim' },
      { label: '内层', op: 'push' },
      { op: 'eq', left: 'g ( a, b )', right: ' g( b  ,  a ) ' },
      { op: 'pop', label: '内层' },
    ],
  };
  const replay = store.submit(reskinned);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.verdict, 'equal');
  assert.equal(replay.body.payloadHash, first.body.payloadHash);
  assert.equal(replay.body.frozenAt, first.body.frozenAt);
});

test('语义差异一律识别为不同载荷：作用域标签 / 元数 / 项内容', () => {
  const variants = [
    // 作用域标签文字变化
    (p) => {
      p.steps = [
        { op: 'push', label: '旧标签' },
        { op: 'pop', label: '旧标签' },
      ];
    },
    (p) => {
      p.steps = [
        { op: 'push', label: '新标签' },
        { op: 'pop', label: '新标签' },
      ];
    },
    // 函数元数变化
    (p) => {
      p.functions = { f: 2 };
    },
    (p) => {
      p.functions = { f: 1 };
    },
    // 项内容变化
    (p) => {
      p.steps = [{ op: 'claim', left: 'f(a)', right: 'f(b)' }];
    },
    (p) => {
      p.steps = [{ op: 'claim', left: 'f(a)', right: 'f(a)' }];
    },
  ];

  // 每对相邻变体：先冻结前者，再用同标识提交后者，必须 409。
  for (let i = 0; i < variants.length; i += 2) {
    const store = new AuditStore();
    const a = basePayload();
    a.auditId = `SEM-DIFF-${i}`;
    variants[i](a);
    assert.equal(store.submit(a).status, 200);

    const b = basePayload();
    b.auditId = `SEM-DIFF-${i}`;
    variants[i + 1](b);
    const res = store.submit(b);
    assert.equal(res.status, 409, `变体对 ${i / 2} 应被识别为不同载荷`);
    assert.equal(res.body.error, 'PAYLOAD_CHANGED');
  }
});

test('同层冲突冻结：neq 后同层 eq 当场驳回并定位到步', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'SAME-LEVEL-1';
  p.steps = [
    { op: 'neq', left: 'a', right: 'b' },
    { op: 'eq', left: 'a', right: 'b' },
  ];
  const { status, body } = store.submit(p);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.verdict, 'rejected');
  assert.equal(body.failure.index, 1);
  assert.equal(body.failure.code, 'SAME_LEVEL_CONFLICT');
  // 同标识同载荷重传仍回放这份驳回裁决
  const replay = store.submit(p);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.failure.code, 'SAME_LEVEL_CONFLICT');
});
