# 深空载荷互连 · 供应商证明审计台

审查供应商证明中的每一步等式推导，在**当时作用域内**是否成立。后端维护一个
**可回滚的同余闭包**（rollback congruence closure）：函数应用只在对应实参等价时
按共享项结构合并；局部配置撤回（`pop`）后内层事实零残留。

## 领域模型

录入：稳定审计标识 `auditId`、有限个常量、定元函数（名称→元数）、至多 180 步证明轨迹。

步骤操作只有五种：

| 步骤 | 含义 |
| ---- | ---- |
| `push`（可带 `label`） | 压入一层局部作用域（快照全部状态） |
| `pop`（可带 `label` 校验） | 弹出当前作用域，回滚该层全部等式/不等式/新项 |
| `eq` | 声明两项相等，自动饱和同余闭包 |
| `neq` | 声明两项不等 |
| `claim` | **不新增断言**，仅声称两项相等（可返回矛盾裁决）并返回可展开依据 |

### 同余闭包

- 项按结构内容寻址驻留（`a`、`f(a,b)`、`g(f(a))` …）。
- 合并两个等价类后，按 `函数 + 各实参当前根` 给所有已驻留应用重新分组，键相同但
  分属不同类的代表项互相合并，迭代到不动点——因此 `f(x) ~ f(y)` **当且仅当** `x ~ y`，
  实参不等价时相同函数应用绝不合并。
- 新提及的应用（可能在其实参早已等价之后才出现）在 `eq/neq/claim` 时补做闭包。
- 每条 union 边带原因（某步声明 / 由哪些实参等式同余传播），`claim` 返回的 `evidence`
  是可逐条展开的依据链，同余边还附其实参所依赖的声明边。

### 同层冲突 vs 跨层矛盾（反证法）

- **同层冲突**：合并会跨越在同一（或更深）作用域声明的不等式 → 当场拒绝，整步回滚
  （连同该步触发的全部同余传播），错误码 `SAME_LEVEL_CONFLICT`，定位到步。
- **跨层矛盾**：内层假设与外层事实冲突（外层 `a≠b`、内层假设 `a=b`；或反之），这是
  合法的反证法形态，不等式被标记，随后的 `claim` 返回 `contradiction`；标记随 `pop` 消失。

其他驳回原因（均定位到具体步骤）：`UNKNOWN_SYMBOL`、`ARITY_MISMATCH`、
`EMPTY_STACK_POP`、`OUT_OF_SCOPE`（跨作用域关闭标签不符）、`BAD_OP`、
`CLAIM_FAILED`（首条不成立声称即截断轨迹）、`TOO_MANY_STEPS`（>180）。

### 冻结 / 重放 / 换载荷拒绝

提交按 `(auditId, SHA-256(canonical payload))` 冻结裁决。规范化只抹平**不改变执行语义**
的表面差异：

- 步骤轨迹**保序**——任何改变 `push`/`pop`/`eq`/`neq`/`claim` 相对位置的重传都是不同
  载荷（先声称后声明绝不会回放先声明后声称的通过裁决）；
- 有限常量是无序集合、函数声明是无序 `名称→元数` 映射、步骤对象字段书写顺序不敏感；
- 项字符串解析后按结构重新渲染，`f( a )` 与 `f(a)` 等不改变项的空白差异不产生新记录；
- 作用域标签按引擎的 `String()` 归并。标签文字、函数元数、项内容、任一步骤内容的变化
  仍识别为不同载荷。

冻结语义：

- 同标识**同载荷**重传 → 回放同一份冻结结果（`replayed: true`，`frozenAt` 不变）；
- 同标识**改换载荷** → HTTP 409 `PAYLOAD_CHANGED`，两个哈希同时返回，旧证据不被覆盖；
- 被驳回的证明同样冻结；前端在新提交前清除页面旧证据。

## API

- `GET /healthz` — 容器健康检查（无 curl/wget 依赖，Node 实现）。
- `POST /api/audits` — 提交/重传证明。
- `GET /api/audits/:auditId` — 读取冻结裁决（完整轨迹、同余类、失败位置）。

## 本地开发

```bash
npm install
npm run test      # 后端 29 项单测（node --test，零运行时依赖）
npm run build     # React + Vite 构建到 web/dist，由 Node 服务托管
npm start --workspace=server   # 或 PORT=9090 node server/src/server.js
```

前端开发服（`npm run dev --workspace=web`）把 `/api`、`/healthz` 代理到后端。

## Compose 编排与一次性 verify

宿主端口可配置：`HOST_PORT=9090 docker compose up --build`。

- `app`：前后端一体，带容器级 healthcheck。
- `verify`：等待 `app` 健康后**只运行一次**——单测 → 生产构建 → 对 `app` 的 HTTP 冒烟，
  随后以检查结果的退出码结束（`restart: "no"`）。

```bash
docker compose build
docker compose run --rm verify   # 或 up 时 verify 自动跑一次
```

> 本仓库开发环境无 Docker 守护进程；`verify` 的三段流程已在宿主 Node 20 上全部跑通
>（退出码 0），Compose 与 Dockerfile 已提供用于真实容器环境。

## 目录

```
server/src/engine.js   可回滚同余闭包（快照 union-find + 同余分组不动点 + 依据链）
server/src/store.js    会话冻结、负载哈希、重放/换载荷拒绝、错误定位
server/src/server.js   零依赖 HTTP API + 健康检查 + 托管 web/dist
server/test/           29 项单测
web/                   React + Vite 页面（轨迹、当前裁决、失败位置、依据展开）
scripts/smoke.js       HTTP 冒烟（verify 容器内运行）
docker-compose.yml     app + 一次性 verify
```
