#!/usr/bin/env node
'use strict';

// End-to-end HTTP smoke test used by the Compose `verify` service.
// Hits a running backend (BASE_URL, default http://localhost:8080) and checks:
//   1. GET /healthz
//   2. a valid scoped proof is accepted (equal)
//   3. identical replay is frozen (replayed=true)
//   4. same id with changed payload is rejected (409 PAYLOAD_CHANGED)
//   5. a stale-scope claim fails at the located step
//   6. a same-level conflict is rejected at the located step
//   7. the frozen record is readable back
//   8. reordering steps after a pass conflicts (409) and leaves the frozen
//      verdict/frozenAt/trace untouched
//   9. reordered declarations / step-field order / term whitespace replay
//      the same frozen result
//  10. a first failing claim is located at step 0
// Exits non-zero on the first unmet expectation.

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = require('http').request(
      url,
      {
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': data.length }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await request('GET', '/healthz');
      if (r.status === 200 && r.body.status === 'ok') return r.body;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`后端在 ${BASE} 未通过健康检查`);
}

(async () => {
  console.log(`HTTP 冒烟目标: ${BASE}`);
  console.log('1) 健康检查');
  const health = await waitForHealthy();
  check('GET /healthz 返回 200/ok', !!health);

  console.log('2) 有效同余证明');
  const valid = {
    auditId: 'SMOKE-VALID-1',
    constants: ['a', 'b', 'c'],
    functions: { f: 1, h: 2 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'push', label: '内层' },
      { op: 'eq', left: 'b', right: 'c' },
      { op: 'claim', left: 'h(a, a)', right: 'h(c, b)' },
      { op: 'pop' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
    ],
  };
  const r2 = await request('POST', '/api/audits', valid);
  check('状态 200', r2.status === 200, r2.status);
  check('裁决 accepted/equal', r2.body.accepted === true && r2.body.verdict === 'equal', r2.body.verdict);
  check('同余类包含 f(a) 与 f(b)', (r2.body.classes || []).some((c) => c.includes('f(a)') && c.includes('f(b)')));
  check('内层 b=c 已随 pop 回滚', !(r2.body.classes || []).some((c) => c.includes('b') && c.includes('c')));

  console.log('3) 同标识同载荷重传 -> 冻结回放');
  const r3 = await request('POST', '/api/audits', valid);
  check('replayed=true', r3.body.replayed === true, r3.body.replayed);
  check('冻结时间一致', r3.body.frozenAt === r2.body.frozenAt);

  console.log('4) 同标识改换载荷 -> 409 拒绝');
  const changed = JSON.parse(JSON.stringify(valid));
  changed.steps.push({ op: 'claim', left: 'a', right: 'c' });
  const r4 = await request('POST', '/api/audits', changed);
  check('HTTP 409', r4.status === 409, r4.status);
  check('错误码 PAYLOAD_CHANGED', r4.body.error === 'PAYLOAD_CHANGED', r4.body.error);

  console.log('5) 失效作用域声称 -> 定位失败步并驳回');
  const stale = {
    auditId: 'SMOKE-STALE-1',
    constants: ['a', 'b'],
    functions: { f: 1 },
    steps: [
      { op: 'push' },
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'pop' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
    ],
  };
  const r5 = await request('POST', '/api/audits', stale);
  check('受理但驳回', r5.status === 200 && r5.body.accepted === false);
  check('失败定位在第 3 步 CLAIM_FAILED', r5.body.failure && r5.body.failure.index === 3 && r5.body.failure.code === 'CLAIM_FAILED', r5.body.failure);

  console.log('6) 同层冲突 -> 驳回');
  const clash = {
    auditId: 'SMOKE-CLASH-1',
    constants: ['a', 'b'],
    functions: {},
    steps: [
      { op: 'neq', left: 'a', right: 'b' },
      { op: 'eq', left: 'a', right: 'b' },
    ],
  };
  const r6 = await request('POST', '/api/audits', clash);
  check('SAME_LEVEL_CONFLICT 于第 1 步', r6.body.accepted === false && r6.body.failure.index === 1 && r6.body.failure.code === 'SAME_LEVEL_CONFLICT', r6.body.failure);

  console.log('7) 读取冻结记录');
  const r7 = await request('GET', `/api/audits/${valid.auditId}`);
  check('GET 回放记录 200', r7.status === 200 && r7.body.auditId === valid.auditId);

  console.log('8) 先通过后交换“声称/声明”次序 -> 409 且原记录不变');
  const ordered = {
    auditId: 'SMOKE-ORDER-1',
    constants: ['a', 'b'],
    functions: { f: 1 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
    ],
  };
  const r8a = await request('POST', '/api/audits', ordered);
  check('首次提交冻结为通过', r8a.status === 200 && r8a.body.verdict === 'equal', r8a.body.verdict);
  const swapped = JSON.parse(JSON.stringify(ordered));
  swapped.steps = [swapped.steps[1], swapped.steps[0]]; // 仅交换步骤次序
  const r8b = await request('POST', '/api/audits', swapped);
  check('重排步骤得到 409 而非旧裁决', r8b.status === 409 && r8b.body.error === 'PAYLOAD_CHANGED', {
    status: r8b.status,
    body: r8b.body,
  });
  const r8c = await request('GET', `/api/audits/${ordered.auditId}`);
  check(
    '原标识结论/冻结时间/轨迹未变',
    r8c.status === 200 &&
      r8c.body.verdict === 'equal' &&
      r8c.body.frozenAt === r8a.body.frozenAt &&
      r8c.body.trace.map((s) => s.op).join(',') === 'eq,claim' &&
      r8c.body.steps.map((s) => s.op).join(',') === 'eq,claim',
    { verdict: r8c.body.verdict, frozenAt: r8c.body.frozenAt }
  );

  console.log('9) 声明重排与项空白差异 -> 稳定回放同一冻结结果');
  const restyled = {
    auditId: ordered.auditId,
    constants: ['b', 'a'], // 常量录入顺序不同
    functions: { f: 1 },
    steps: [
      { right: ' b ', left: 'a', op: 'eq' }, // 字段书写顺序 + 项空白差异
      { op: 'claim', left: ' f(a)', right: 'f( b )' },
    ],
  };
  const r9 = await request('POST', '/api/audits', restyled);
  check(
    '回放同一冻结结果',
    r9.status === 200 && r9.body.replayed === true && r9.body.frozenAt === r8a.body.frozenAt && r9.body.verdict === 'equal',
    { status: r9.status, replayed: r9.body && r9.body.replayed }
  );

  console.log('10) 首条不成立声称 -> 定位第 0 步并驳回');
  const firstClaimFails = {
    auditId: 'SMOKE-ORDER-2',
    constants: ['a', 'b'],
    functions: { f: 1 },
    steps: [
      { op: 'claim', left: 'f(a)', right: 'f(b)' }, // 交换次序后的轨迹：首条声称即不成立
      { op: 'eq', left: 'a', right: 'b' },
    ],
  };
  const r10 = await request('POST', '/api/audits', firstClaimFails);
  check(
    'CLAIM_FAILED 于第 0 步',
    r10.status === 200 && r10.body.accepted === false && r10.body.failure.index === 0 && r10.body.failure.code === 'CLAIM_FAILED',
    r10.body.failure
  );

  if (failures) {
    console.error(`\n冒烟失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部 HTTP 冒烟检查通过');
  process.exit(0);
})().catch((err) => {
  console.error('冒烟脚本异常:', err.message);
  process.exit(1);
});
