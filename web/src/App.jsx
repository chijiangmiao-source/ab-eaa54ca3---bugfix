import React, { useEffect, useMemo, useState } from 'react';

const SAMPLE = {
  auditId: 'DSI-AUDIT-2026-0001',
  constants: 'a, b, c, d',
  functions: 'f:1, h:2, k:1',
  stepsText: JSON.stringify(
    [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'push', label: '局部配置' },
      { op: 'eq', left: 'b', right: 'c' },
      { op: 'claim', left: 'h(a, d)', right: 'h(c, d)' },
      { op: 'pop' },
      { op: 'claim', left: 'f(a)', right: 'f(b)' },
      { op: 'claim', left: 'a', right: 'c' }
    ],
    null,
    2
  ),
};

function parseNameList(text) {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFunctions(text) {
  const out = {};
  for (const piece of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = piece.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\d+)$/);
    if (!m) throw new Error(`函数声明格式错误: "${piece}"，应为 名称:元数`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

const VERDICT_TEXT = {
  equal: '等式成立',
  contradiction: '已出现矛盾（反证法假设与外层事实冲突）',
  rejected: '证明被驳回',
  pending: '尚无声称',
};

export default function App() {
  const [auditId, setAuditId] = useState(SAMPLE.auditId);
  const [constants, setConstants] = useState(SAMPLE.constants);
  const [functions, setFunctions] = useState(SAMPLE.functions);
  const [stepsText, setStepsText] = useState(SAMPLE.stepsText);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState(null);

  const refreshHealth = async () => {
    try {
      const r = await fetch('/healthz');
      setHealth(r.ok ? await r.json() : { status: 'bad' });
    } catch {
      setHealth({ status: 'bad' });
    }
  };

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 5000);
    return () => clearInterval(t);
  }, []);

  const parsedSteps = useMemo(() => {
    try {
      const v = JSON.parse(stepsText);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }, [stepsText]);

  const buildPayload = () => {
    const fns = parseFunctions(functions);
    const steps = JSON.parse(stepsText);
    if (!Array.isArray(steps)) throw new Error('steps 必须是 JSON 数组');
    if (steps.length > 180) throw new Error('证明轨迹至多 180 步');
    return {
      auditId: auditId.trim(),
      constants: parseNameList(constants),
      functions: fns,
      steps,
    };
  };

  const submit = async () => {
    setLoading(true);
    setSubmitError(null);
    setResult(null); // 清除页面旧证据
    try {
      const payload = buildPayload();
      const r = await fetch('/api/audits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json();
      if (body.error === 'PAYLOAD_CHANGED') {
        setSubmitError(body);
      } else {
        setResult(body);
      }
    } catch (err) {
      setSubmitError({ error: 'CLIENT_ERROR', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>深空载荷互连 · 供应商证明审计台</h1>
          <p className="subtitle">
            可回滚同余闭包：相同函数应用仅在实参等价时合并 · pop 后内层事实不残留
          </p>
        </div>
        <HealthBadge health={health} />
      </header>

      <main className="layout">
        <section className="panel editor">
          <h2>证明录入</h2>
          <label className="field">
            <span>稳定审计标识</span>
            <input value={auditId} onChange={(e) => setAuditId(e.target.value)} />
          </label>
          <label className="field">
            <span>有限个常量（逗号分隔）</span>
            <input value={constants} onChange={(e) => setConstants(e.target.value)} />
          </label>
          <label className="field">
            <span>定元函数（名称:元数，逗号分隔）</span>
            <input value={functions} onChange={(e) => setFunctions(e.target.value)} />
          </label>
          <label className="field">
            <span>
              证明轨迹（≤180 步：push / pop / eq / neq / claim）
              {parsedSteps === null && <em className="warn">JSON 无法解析</em>}
              {parsedSteps && <em className="ok">{parsedSteps.length} 步</em>}
            </span>
            <textarea
              rows={18}
              spellCheck="false"
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
            />
          </label>
          <div className="actions">
            <button onClick={submit} disabled={loading || parsedSteps === null}>
              {loading ? '审查中…' : '提交审查 / 重传回放'}
            </button>
            <button
              className="ghost"
              onClick={() => {
                setResult(null);
                setSubmitError(null);
              }}
            >
              清除页面证据
            </button>
          </div>
          <p className="hint">
            同标识同载荷重传将回放冻结结果；同标识改换载荷会被明确拒绝（409）。
          </p>
        </section>

        <section className="panel verdict-panel">
          <h2>当前裁决与轨迹</h2>
          {submitError && <PayloadChanged error={submitError} />}
          {!submitError && !result && <EmptyState />}
          {result && <Verdict result={result} />}
        </section>
      </main>
    </div>
  );
}

function HealthBadge({ health }) {
  const ok = health && health.status === 'ok';
  return (
    <div className={`health ${ok ? 'up' : 'down'}`}>
      <span className="dot" />
      {ok ? `后端健康 · 会话 ${health.sessions}` : health === null ? '探测中…' : '后端不可达'}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <p>尚未提交证明。</p>
      <p>左侧示例展示：内层引入的 b=c 在 pop 后失效，因此最后一条 claim(a,c) 将被定位为首个不成立的声称。</p>
    </div>
  );
}

function PayloadChanged({ error }) {
  if (error.error === 'PAYLOAD_CHANGED') {
    return (
      <div className="fatal">
        <h3>⛔ 改换载荷被拒绝（409）</h3>
        <p>{error.message}</p>
        <dl className="hashes">
          <dt>已冻结载荷哈希</dt>
          <dd><code>{error.frozenPayloadHash}</code></dd>
          <dt>本次重传哈希</dt>
          <dd><code>{error.receivedPayloadHash}</code></dd>
        </dl>
      </div>
    );
  }
  return (
    <div className="fatal">
      <h3>请求未送达</h3>
      <p>{error.message}</p>
    </div>
  );
}

function Verdict({ result }) {
  const failedIndex = result.failure ? result.failure.index : null;
  return (
    <div>
      <div className={`verdict ${result.accepted ? 'ok' : 'bad'}`}>
        <div className="verdict-main">
          {result.replayed ? '⟲ 回放冻结结果' : result.accepted ? '✔ 证明通过' : '✘ 证明驳回'}
        </div>
        <div className="verdict-sub">{VERDICT_TEXT[result.verdict] || result.verdict}</div>
        <div className="verdict-meta">
          <span>标识：<code>{result.auditId}</code></span>
          <span>载荷：<code>{result.payloadHash ? result.payloadHash.slice(0, 16) + '…' : '—'}</code></span>
          <span>冻结于：{result.frozenAt}</span>
        </div>
      </div>

      {result.failure && (
        <div className="failure">
          <h3>失败位置：第 {result.failure.index} 步</h3>
          <p className="failure-code">错误码 {result.failure.code}</p>
          <p>{result.failure.message}</p>
          {result.failure.detail && result.failure.detail.chain && (
            <EvidenceChain chain={result.failure.detail.chain} />
          )}
        </div>
      )}

      <h3>逐步轨迹</h3>
      <ol className="trace">
        {(result.trace || []).map((s) => (
          <TraceRow key={s.index} step={s} />
        ))}
        {failedIndex !== null && (
          <li className="step failed">
            <div className="step-head">
              <b>#{failedIndex}</b>
              <span className="op">{(result.steps?.[failedIndex] || {}).op || '?'}</span>
            </div>
            <div className="step-detail">该步及之后未被受理，旧证据在此截断。</div>
          </li>
        )}
      </ol>

      {result.accepted && (
        <>
          <h3>当前同余类</h3>
          <ul className="classes">
            {(result.classes || []).map((c, i) => (
              <li key={i}>{`{ ${c.join(',  ')} }`}</li>
            ))}
          </ul>
          <p className="hint">
            作用域深度 {result.scopeDepth}
            {result.openScopes && result.openScopes.length
              ? `，未关闭：${result.openScopes.map((l) => l || '未命名').join('、')}`
              : '，所有局部作用域均已闭合'}
          </p>
        </>
      )}
    </div>
  );
}

function TraceRow({ step }) {
  const [open, setOpen] = useState(false);
  const hasEvidence =
    (step.evidence && step.evidence.length) || (step.propagation && step.propagation.length) || step.contradiction;
  return (
    <li className={`step depth-${step.scopeDepth}`}>
      <div className="step-head">
        <b>#{step.index}</b>
        <span className="op">{step.op}</span>
        {step.label && <span className="label">{step.label}</span>}
        <span className="depth-tag">L{step.scopeDepth}</span>
        {step.verdict && (
          <span className={`claim-tag ${step.verdict}`}>
            {step.verdict === 'contradiction' ? '矛盾声称' : '相等声称'}
          </span>
        )}
        {hasEvidence ? (
          <button className="expand" onClick={() => setOpen((v) => !v)}>
            {open ? '收起依据' : '展开依据'}
          </button>
        ) : null}
      </div>
      <div className="step-detail">{step.detail}</div>
      {open && (
        <div className="evidence">
          {step.propagation && step.propagation.length > 0 && (
            <>
              <h4>同余传播</h4>
              <ul>
                {step.propagation.map((p, i) => (
                  <li key={i}>
                    <code>{p.a}</code> ≡ <code>{p.b}</code>
                    <span className="hint">（实参成对等价：
                      {p.via.map((v) => `${v.arg}~${v.congruentTo}`).join(', ')}）</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {step.evidence && <EvidenceChain chain={step.evidence} />}
          {step.contradiction && (
            <div className="contradiction">
              <h4>矛盾确认</h4>
              <p>
                <code>{step.contradiction.left}</code> 与 <code>{step.contradiction.right}</code>
                在第 {step.contradiction.equalityStep ?? '?'} 步被合并，却在第{' '}
                {step.contradiction.inequalityStep} 步被声明不等；该矛盾属于内层假设，随作用域 pop 回滚。
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function EvidenceChain({ chain }) {
  if (!chain || !chain.length) return null;
  return (
    <div className="evidence">
      <h4>可展开依据链</h4>
      <ol className="chain">
        {chain.map((e, i) => (
          <li key={i}>
            <code>{e.left}</code> = <code>{e.right}</code>
            <span className={`badge ${e.kind}`}>
              {e.kind === 'declared' ? `第 ${e.step} 步声明` : `第 ${e.step} 步同余传播`}
            </span>
            {e.kind === 'congruence' && (
              <span className="hint">
                {' '}
                函数 {e.function}：
                {e.matchedArguments.map((m) => `${m.arg}~${m.congruentTo}`).join(', ')}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
