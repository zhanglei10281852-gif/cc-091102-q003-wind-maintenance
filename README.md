# 风机检修窗口协调

风场调度使用本服务安排登塔检查、窗口改期和候补递补。申请以版本区分每次改期，风险等级相同时保留最初排队时间。现场事件样例位于 `fixtures/incident.json`。

使用 Node.js 20 运行。`npm test` 校验领域资料，`npm start` 启动状态接口；本地运行数据写入 `data/`，不得提交人员凭据。

## 领域模型

- **申请（request）**：以 `requestId` 标识，绑定风机 `turbine` 与作业班组 `crew`；每次改期产生新版本，只有最新版本参与调度，旧版本进入 `rescheduled` 终态，不会回到候补队列。
- **状态机**：`submitted`（候补中）→ `window-held`（已占窗口）→ `approved`（已锁定）→ `completed`；任何非终态都可 `cancelled`；被改期取代的版本为 `rescheduled`。
- **容量**：`capacity` 为可同时持有的窗口数，占用数 = 处于 `window-held` / `approved` 的版本数，由状态派生，不存在可被扣成负数的计数器。

## 递补规则

1. 候补排序：风险等级（`critical` > `high` > `routine`）→ 最初排队时间 `queuedAt`（改期保留原值）→ `requestId`。排序只依赖事件内容，重放结果确定。
2. 一次释放只交给一个当前有效申请；扩容时逐个空位递补。
3. 同一班组、同一风机同一时间只能持有一个窗口；排名靠前但冲突的申请会被跳过，并在响应中给出具体理由（`crew-window-held` / `turbine-window-held`）。
4. 取消、完成、改期释放出的窗口立即自动递补；缩容不驱逐在窗班组，仅暂停后续递补。

## 可靠性保证

- **事件溯源**：接受的命令追加到 `data/events.jsonl` 并 fsync；重启后按序重放，占用数与递补顺序与故障前完全一致（`POST /debug/replay` 可随时校验）。
- **幂等**：命令可带 `eventId`，重复投递返回首次结果；不带幂等键的重复/乱序命令由版本精确校验与状态机拒绝（`stale-version`、`already-cancelled` 等），不会造成负容量。
- **版本精确**：锁定、改期、取消、完成都必须指定当前版本号；迟到的旧版本命令被拒绝，不会误伤当前版本。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/requests` | 提交申请 `{requestId, turbine, crew, risk, queuedAt?, eventId?}` |
| POST | `/requests/:id/reschedule` | 改期 `{baseVersion, risk?, eventId?}`，生成新版本 |
| POST | `/requests/:id/lock` | 锁定窗口 `{version, eventId?}` |
| POST | `/requests/:id/cancel` | 取消 `{version, eventId?}` |
| POST | `/requests/:id/complete` | 完成 `{version, eventId?}` |
| POST | `/cancellations` | 批量取消 `{items: [{requestId, version}...], eventId?}`，响应含递补班组与跳过理由 |
| POST | `/capacity` | 设置窗口容量 `{capacity, eventId?}` |
| GET | `/state` | 容量、占用、在窗班组、候补队列（含位次） |
| GET | `/requests/:id` | 单个申请及全部版本 |
| GET | `/events?limit=` | 最近事件日志 |
| POST | `/debug/replay` | 从日志重建状态并与当前状态比对 |

命令被接受返回 200 及结果（含 `promotions`、`skipped`、`occupancy`）；参数错误返回 400；未知申请返回 404；版本/状态冲突返回 409 及 `reason`。

## 运行

```sh
npm start                 # PORT=8080 DATA_DIR=data WINDOW_CAPACITY=1
npm test                  # node --test
```
