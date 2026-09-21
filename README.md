# 风机检修窗口协调

风场调度使用本服务安排登塔检查、窗口改期和候补递补。申请以版本区分每次改期，风险等级相同时保留最初排队时间。现场事件样例位于 `fixtures/incident.json`。

使用 Node.js 20+ 运行，无第三方依赖。`npm test` 运行测试，`npm start` 启动服务；本地数据写入 `data/events.jsonl`（可通过 `EVENT_LOG` 覆盖），不得提交人员凭据。

## 模型与规则

- **风机**：`turbineId` 与当日容量 `capacity`（并发登塔窗口数）。
- **班组**：`crewId`；同一班组同一时刻只能持有一个窗口（跨风机也不行）。
- **申请**：`requestId` + 单调递增 `version`，字段为风机、班组、风险（`critical` / `high` / `routine`）、最初排队时间 `queuedAt`。
- **状态**：`submitted`（候补中）→ `window-held`（已锁定窗口）→ `approved`（已审批）→ `completed`；`rescheduled`（旧版本，永不回候补）、`cancelled`。
- **确定性递补**：风险降序；风险相同按最初排队时间升序（改期不改变先后）；再以 `requestId`、`version` 兜底。每锁定一个窗口才消耗一个空位，一次释放最多交给一个当前有效申请。
- **容量安全**：占用数由事件折叠状态派生；乱序/重复事件（按 `eventId` 去重、状态迁移前置校验）不会产生负容量或双重锁定。
- **事件溯源**：所有命令只追加写入 JSONL 事件日志；重启时按序重放，占用数与递补顺序逐字节一致。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/turbines` | 登记风机 `{turbineId, capacity}` |
| POST | `/crews` | 登记班组 `{crewId}` |
| GET | `/turbines` / `/requests` | 全量快照（占用、持窗、候补、申请版本） |
| GET | `/turbines/:id` | 单台风机视图 |
| POST | `/requests` | 提交申请（首次 `version` 省略或为 1；再提交接续版本会自动作废旧版本） |
| GET | `/requests/:id` | 申请的全部版本与当前状态 |
| POST | `/requests/:id/reschedule` | 改期 `{turbine?, crew?, risk?}`，保留最初排队时间 |
| POST | `/requests/:id/approve` | 审批已锁定窗口 |
| POST | `/requests/:id/complete` | 完成作业并释放窗口 |
| POST | `/requests/:id/cancel` | 取消并触发递补 |
| POST | `/cancel-batch` | 批量取消 `{requestIds: [...]}` |
| GET | `/events` | 已持久化事件（审计/排障） |

每个写操作响应中带 `promotion`：

```json
{
  "cancelled": [{"requestId": "WT-1", "version": 1}],
  "errors": [{"requestId": "WT-9", "code": "not-found", "message": "申请不存在"}],
  "promotion": {
    "granted": [{"requestId": "WT-2", "version": 1, "crew": "blade-b", "state": "window-held", "...": "..."}],
    "skipped": [{"requestId": "WT-3", "version": 1, "turbine": "W-1", "reason": "crew-already-held",
                 "busyTurbine": "W-2", "busyRequestId": "WT-8", "busyVersion": 1}],
    "events": [{"eventId": "held:WT-2:v1", "type": "window-held", "...": "..."}]
  }
}
```

批量取消后调度员可立即看到：`granted` 为获得窗口的班组，`skipped` 为被跳过的申请及理由（`superseded-version` 旧版本 / `crew-already-held` 班组在别处持窗，附占用位置）。

## 代码结构

- `src/domain.js`：纯函数领域层（事件折叠、确定性排序、递补、快照）。
- `src/store.js`：JSONL 追加式事件存储。
- `src/service.js`：命令校验、版本管理、串行提交与“先写盘后生效”。
- `src/server.js`：HTTP API，启动时重放事件日志。
