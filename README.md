# verifiable-draw

可验证的公开抽签 API：承诺-揭示（commit-reveal）协议 + 基于 SHA-256 拒绝采样的 Fisher-Yates 洗牌，保证中奖顺序**无偏、可复算、可审计**。支持两种熵来源：

- **单 nonce 模式**（兼容旧流程）：调用方揭示一次公共 nonce。
- **多人承诺模式**：创建抽签时声明参与者名单，每人先提交 `SHA-256(secret)` 承诺、再揭示 secret；全部揭示后，服务端按**固定参与者顺序**拼接各人 secret 的哈希作为 nonce。任一方都无法单独左右结果，整条贡献链可审计。

所有**新建**抽签（单人与多人）使用 **v2 协议**：承诺不仅绑定 seed，还绑定创建时的**候选快照**（候选顺序、原始 UTF-8 字节内容与 count），事后改动候选名单或抽取数量都会使承诺校验失败。v2 之前落库的记录自动标记为 **v1**，永久按旧算法 `SHA-256(seed)` 可查可验，无需任何手工处理。

技术栈：Node.js 24 + Fastify 5 + SQLite（Node 内置 `node:sqlite`，零原生依赖）。

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

服务地址：**http://localhost:3000** （首次启动自动建表，无需手动迁移；旧版数据库会在启动时自动迁移）。

常用命令：

```bash
docker compose up --build -d   # 后台运行
docker compose ps              # 查看状态（含 healthcheck）
docker compose logs -f app     # 跟踪日志
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除抽签数据
```

健康检查：`GET http://localhost:3000/health` → `{"status":"ok"}`。

不使用容器时：`npm ci && npm start`（需 Node.js ≥ 22.13）。

## 配置（环境变量，均有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_PATH` | 容器内 `/app/data/draws.db`，本地 `./data/draws.db` | SQLite 文件路径 |

SQLite 数据通过 compose 的命名卷 `draw-data` 持久化。

## 抽签流程

### 单 nonce 模式（默认，旧记录完全兼容）

1. **创建（承诺，v2）**：提交去重后的候选项与抽取数量（不传 `participants`）。服务端生成 32 字节随机 seed，按原始候选顺序计算候选快照摘要 `snapshotDigest`（算法见文末），公布 `commitment = SHA-256('v2:'+seed+':'+snapshotDigest)`，并持久化 `version=2` 与 `snapshotDigest`；seed 在揭示前不会出现在任何响应中。
2. **揭示**：调用方提交一次 `nonce`（仅一次，重复提交返回 409）。服务端在**同一事务**（`BEGIN IMMEDIATE`）中锁定该抽签、落库 nonce、揭示 seed 并持久化中奖顺序。
3. **校验**：任何人用「版本 + 承诺 + seed + nonce + 候选快照（+ 摘要）」即可独立重算承诺与中奖顺序；候选顺序、内容或 count 被改动都会导致校验失败。

### 多人承诺模式（熵汇聚）

创建抽签时声明 `participants`（2–100 人，名单去重，顺序即后续 nonce 的拼接顺序），随后分两个阶段进行，所有写操作都在 `BEGIN IMMEDIATE` 事务内锁定抽签并**拒绝重复或越序操作**：

1. **承诺阶段（`pending → committed`）**：每位参与者调用
   `POST /draws/:id/participants/:name/commitment` 提交 `commitment = SHA-256(secret)`（64 位小写 hex）。第一个承诺落地后抽签进入 `committed` 阶段；同一参与者重复承诺返回 `409`；未声明的名字返回 `400`。承诺与揭示均允许乱序到达。
2. **揭示阶段（`committed → revealed`）**：
   - 只要还有参与者未承诺，任何揭示都会被拒绝（`409`，响应里给出 `waitingFor` 名单）。
   - 参与者调用 `POST /draws/:id/participants/:name/reveal` 提交 secret，服务端校验 `SHA-256(secret)` 与其承诺一致（不一致返回 `409`），重复揭示返回 `409`。
   - **最后一个揭示在同一事务内**：按创建时的固定参与者顺序拼接 `SHA-256(secret_i)` 得到 nonce（每段固定 64 hex，无分隔符、无歧义），复用现有洗牌算法算出顺序并落库、揭示 seed。
3. **审计**：完成后的响应（及 `GET /draws/:id`）与单人模式一致地带 `version`（新建为 `2`）、`snapshotDigest`、`seed` 等字段，并包含 `contributions` 列表——每位参与者的位置、承诺、secret、secret 哈希与两个时间戳。任何人都能用它重新拼出 nonce，再通过 `/verify`（带 `version:2` 与候选快照）独立复算承诺与开奖顺序。

## API

### 1. 创建抽签

```bash
curl -X POST http://localhost:3000/draws \
  -H 'content-type: application/json' \
  -d '{"candidates":["alice","bob","carol","dave","erin"],"count":2}'
```

```json
{ "drawId": "bde4b5b9-…", "status": "pending", "version": 2,
  "commitment": "a5b10695…", "snapshotDigest": "9f2c…（64 位 hex）",
  "count": 2, "candidateCount": 5, "createdAt": "…" }
```

### 2. 揭示（nonce 只能提交一次）

```bash
curl -X POST http://localhost:3000/draws/<drawId>/reveal \
  -H 'content-type: application/json' \
  -d '{"nonce":"public-input-2026-09-20"}'
```

```json
{ "drawId": "…", "status": "revealed", "version": 2, "commitment": "a5b10695…",
  "snapshotDigest": "9f2c…", "seed": "a196a11e…",
  "nonce": "public-input-2026-09-20", "candidates": ["alice", "…"],
  "order": ["grace", "bob", "…"], "winners": ["grace", "bob"], "revealedAt": "…" }
```

`order` 为全量中奖顺序，`winners` 为前 `count` 名。重复揭示返回 `409` 及首次揭示结果。v1 旧记录的响应不含 `snapshotDigest`，`version` 为 `1`。

### 3. 查询状态

```bash
curl http://localhost:3000/draws/<drawId>
```

多人抽签的状态响应额外包含 `participants`（含每人 `status: pending|committed|revealed`、承诺与时间戳；secret 在整体揭示前不返回）以及 `committedCount` / `revealedCount` 计数。所有响应都带 `version`（新建记录为 `2`）；v2 记录在揭示前后均带 `snapshotDigest`，揭示后才带 `seed` / `nonce` / `order` / `winners`。

### 3a. 多人模式：创建 + 承诺 + 揭示

```bash
# 1) 创建时声明参与者（顺序固定，即 nonce 拼接顺序）
DRAW=$(curl -s -X POST http://localhost:3000/draws \
  -H 'content-type: application/json' \
  -d '{"candidates":["alice","bob","carol","dave","erin"],"count":2,
       "participants":["alice","bob","carol"]}')
ID=$(echo "$DRAW" | sed -E 's/.*"drawId":"([^"]+)".*/\1/')

# 2) 每人本地生成 secret，只提交其 SHA-256 承诺
for name in alice bob carol; do
  read -s secret"?$name secret: "   # 或自行生成：openssl rand -hex 32
  curl -s -X POST http://localhost:3000/draws/$ID/participants/$name/commitment \
    -H 'content-type: application/json' \
    -d "{\"commitment\":\"$(printf %s "$secret" | sha256sum | cut -d' ' -f1)\"}"
done

# 3) 全部承诺后再揭示 secret（可乱序；最后一个揭示触发开奖）
curl -s -X POST http://localhost:3000/draws/$ID/participants/carol/reveal \
  -H 'content-type: application/json' -d '{"secret":"carol-secret"}'
curl -s -X POST http://localhost:3000/draws/$ID/participants/alice/reveal \
  -H 'content-type: application/json' -d '{"secret":"alice-secret"}'
curl -s -X POST http://localhost:3000/draws/$ID/participants/bob/reveal \
  -H 'content-type: application/json' -d '{"secret":"bob-secret"}'
```

最后一个揭示的响应与单 nonce 模式结构一致（`seed` / `nonce` / `order` / `winners`），并额外给出：

```json
{ "mode": "multiparty", "status": "revealed",
  "nonce": "<sha256(alice-secret)><sha256(bob-secret)><sha256(carol-secret)>",
  "participants": [ { "name": "alice", "position": 0, "status": "revealed",
                      "commitment": "…", "secret": "alice-secret", "secretHash": "…" } ],
  "contributions": [ { "name": "alice", "position": 0, "commitment": "…",
                       "secret": "…", "secretHash": "…",
                       "committedAt": "…", "revealedAt": "…" } ] }
```

阶段/顺序错误码：

| 场景 | 状态码 |
|---|---|
| 未声明的参与者名字提交承诺/揭示 | `400` |
| 承诺不是 64 位小写 hex | `400` |
| 同一参与者重复承诺 / 重复揭示 | `409` |
| 尚有参与者未承诺就揭示（附 `waitingFor`） | `409` |
| secret 与其承诺不一致 | `409` |
| 开奖后再提交承诺/揭示（附最终 `draw`） | `409` |
| 对多人抽签调 `/reveal`，或对单人抽签调参与者接口 | `409` |

### 4. 独立校验（核心）

提交版本、承诺、seed、nonce 与候选快照，服务端按版本重算承诺与中奖顺序并逐项指出篡改：

```bash
curl -X POST http://localhost:3000/verify \
  -H 'content-type: application/json' \
  -d '{"version":2,"commitment":"a5b10695…","snapshotDigest":"9f2c…",
       "seed":"a196a11e…","nonce":"public-input-2026-09-20",
       "candidates":["alice","bob","carol","dave","erin"],"count":2,
       "order":["grace","bob","…"],"winners":["grace","bob"]}'
```

```json
{ "valid": true, "version": 2,
  "checks": { "candidatesUnique": true, "countInRange": true,
              "snapshotDigestMatch": true, "commitmentMatch": true,
              "orderMatch": true, "winnersMatch": true },
  "expected": { "order": ["…"], "winners": ["…"] },
  "problems": [] }
```

字段约定：

- `version`（可选）：`2` 按新版承诺与快照校验；**缺省为 `1`，按旧算法 `SHA-256(seed)` 校验**。服务端响应始终回显实际使用的版本。
- `snapshotDigest`（v2 可选）：创建时公布的 64 位 hex 摘要。不传时服务端仍会用 `candidates`+`count` 重算摘要并据此重算承诺——因此候选顺序、内容或 count 的任何改动都无法通过 `commitmentMatch`。
- `order`、`winners` 为可选，不传则只校验承诺并重算期望值。

任一字段被篡改时 `valid=false`，`problems` 会指明哪一项不一致（如 `snapshot digest mismatch` / `commitment mismatch` / `order mismatch`）。v2 下：改动候选顺序或内容、改动 count 会使 `snapshotDigestMatch` 与 `commitmentMatch` 同时失败；改动 seed 使 `commitmentMatch` 失败；改动 nonce/order 使相应重算项失败。

多人抽签可在 `/verify` 请求体中追加 `contributions`（按参与者顺序的 `{position, commitment, secret}` 列表），服务端会额外校验：

- `positionsComplete`：`position` 为从 0 开始的连续序号；
- `commitmentsOpen`：每条都满足 `SHA-256(secret) == commitment`；
- `nonceDerived`：按位置顺序拼接 `SHA-256(secret)` 恰好等于 `nonce`，并用重导出的 nonce 复算 `order`。

另外 `GET /draws/:id/verify` 可对服务端存储的记录做一致性重算（自动使用落库的 `version`/`snapshotDigest`；多人模式自动带上 `contributions` 并检查上述三项）。v1 旧记录经此端点与 POST `/verify`（省略 `version`）均仍可验。

## 算法规范（第三方可独立复算）

- **seed**：32 字节加密随机数，hex 编码（64 字符）。
- **候选快照编码（v2）**：按创建时的原始候选顺序拼接以下字节串：
  - 先放 `count` 的十进制文本与一个换行符 `\n`（仅此一个换行）；
  - 随后对每一项依次放「该项的 **UTF-8 字节长度**十进制、`:`、该项的**原始 UTF-8 字节**」。

  即 `snapshot = "<count>\n" ‖ "〈len(c_0)〉:"‖c_0 ‖ "〈len(c_1)〉:"‖c_1 ‖ …`，其中 `c_i` 为原始字节，长度按 UTF-8 字节计（非 JS 字符数）。长度前缀保证候选项本身含数字、`:` 或换行时编码依然无歧义。
- **候选快照摘要（v2）**：`snapshotDigest = SHA-256(snapshot)`，64 字符小写 hex，创建时持久化并公布。
- **承诺**：
  - **v2（所有新建抽签）**：`commitment = SHA-256("v2:" ‖ seed ‖ ":" ‖ snapshotDigest)`（对拼接字符串的 UTF-8 字节求哈希）。承诺同时绑定 seed 与候选快照；候选顺序、内容或 count 任一改变都会令承诺失配。
  - **v1（旧记录，缺省版本）**：`commitment = SHA-256(seed)`。旧数据库迁移后标记 `version=1`、摘要为空，继续按本式验证。
- **参与者承诺**：`commitment_i = SHA-256(secret_i)`，同样为 64 字符 hex；揭示时必须精确匹配。
- **熵汇聚 nonce**：多人模式下，按创建时声明的固定参与者顺序（position 0…n−1）拼接
  `nonce = SHA-256(secret_0) ‖ SHA-256(secret_1) ‖ … ‖ SHA-256(secret_(n−1))`，
  每段固定 64 hex（无分隔符）。单 nonce 模式直接使用调用方提交的 nonce。
- **随机流**：第 `i` 块（`i = 0, 1, 2, …`）为 `SHA-256("{seed}:{nonce}:{i}")`，每块 32 字节按大端序切成 8 个 uint32，依次消费。
- **拒绝采样**：取 `[0, n)` 均匀整数时，令 `limit = floor(2^32 / n) * n`，丢弃 `x >= limit` 的样本，返回 `x % n`，消除模偏差。
- **Fisher-Yates**：对候选副本从末尾向前，`j = uniform(i + 1)` 交换，得到全量中奖顺序；前 `count` 个为中奖者。

## 本地开发（可选）

需要 Node.js ≥ 22.13（内置 `node:sqlite`）：

```bash
npm ci
npm start     # http://localhost:3000
npm test      # node:test 测试套件（含无偏性统计检验）
```

## 项目结构

```
src/lottery.js          承诺生成、SHA-256 随机流、拒绝采样、Fisher-Yates、多人 secret 哈希汇聚
src/db.js               SQLite 连接、自动建表与旧版 schema 迁移（v0 → v1 → v2；旧记录保留 v1 语义）
src/app.js              Fastify 路由（创建 / 单人揭示 / 多人承诺·揭示 / 查询 / 校验）
src/index.js            入口：配置、启动、优雅退出
test/api.test.js        单 nonce 模式端到端与篡改检测测试
test/multiparty.test.js 多人承诺模式阶段锁定、越序拒绝、汇聚与审计测试
```
