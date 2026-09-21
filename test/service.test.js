import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { SchedulingService, ApiError } from '../src/service.js';

let clock;
const dirs = [];
async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), 'wind-'));
  dirs.push(dir);
  clock = new MockClock();
  const service = new SchedulingService(new EventStore(join(dir, 'events.jsonl')), { now: () => clock.now() });
  await service.load();
  return service;
}

class MockClock {
  constructor() { this.value = '2026-09-21T00:00:00.000Z'; this.n = 0; }
  now() { this.n += 1; return `2026-09-21T00:${String(this.n).padStart(3, '0')}Z`; }
}

test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function bootstrap(service) {
  await service.registerTurbine({ turbineId: 'W-1', capacity: 2 });
  await service.registerTurbine({ turbineId: 'W-2', capacity: 1 });
  for (const crewId of ['blade-a', 'blade-b', 'blade-c', 'blade-d']) {
    await service.registerCrew({ crewId });
  }
}

test('提交后按风险与最初排队时间自动锁定', async () => {
  const service = await makeService();
  await bootstrap(service);

  const r1 = await service.submit({ requestId: 'WT-001', turbine: 'W-1', crew: 'blade-a', risk: 'routine', queuedAt: '2026-09-20T06:00:00+08:00' });
  assert.equal(r1.request.state, 'window-held');
  await service.submit({ requestId: 'WT-002', turbine: 'W-1', crew: 'blade-b', risk: 'critical', queuedAt: '2026-09-20T09:00:00+08:00' });
  await service.submit({ requestId: 'WT-003', turbine: 'W-1', crew: 'blade-c', risk: 'high', queuedAt: '2026-09-20T08:00:00+08:00' });

  const turbine = service.getTurbine('W-1');
  assert.deepEqual(turbine.held.map((r) => r.requestId), ['WT-002', 'WT-001']); // critical 插队，routine 先占位
  assert.equal(turbine.occupancy, 2);
  assert.deepEqual(turbine.queue.map((r) => r.requestId), ['WT-003']);
});

test('改期产生新版本、旧版本失效且保留最初排队时间', async () => {
  const service = await makeService();
  await bootstrap(service);
  await service.submit({ requestId: 'WT-071', turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:30:00+08:00' });
  await service.submit({ requestId: 'WT-072', turbine: 'W-1', crew: 'blade-b', risk: 'high', queuedAt: '2026-09-20T07:00:00+08:00' });

  const res = await service.reschedule('WT-071', { turbine: 'W-1', crew: 'blade-a', risk: 'high' });
  assert.equal(res.request.version, 2);
  assert.equal(res.request.queuedAt, '2026-09-20T06:30:00+08:00'); // 保留最初排队时间
  assert.equal(res.superseded, 1);

  const full = service.getRequest('WT-071');
  assert.deepEqual(full.versions.map((v) => [v.version, v.state]), [[1, 'rescheduled'], [2, 'window-held']]);
  // v2 凭原始排队时间排在 WT-072 之前，抢到窗口
  const turbine = service.getTurbine('W-1');
  assert.deepEqual(turbine.held.map((r) => `${r.requestId}#v${r.version}`), ['WT-071#v2', 'WT-072#v1']);
});

test('批量取消后立即返回获得窗口的班组与跳过理由', async () => {
  const service = await makeService();
  await bootstrap(service);
  // W-2 容量 1：blade-d 先占；blade-c 对 W-2 的申请将因班组空闲情况参与候补
  await service.submit({ requestId: 'WT-101', turbine: 'W-1', crew: 'blade-a', risk: 'routine', queuedAt: '2026-09-20T06:00:00+08:00' });
  await service.submit({ requestId: 'WT-102', turbine: 'W-1', crew: 'blade-b', risk: 'routine', queuedAt: '2026-09-20T07:00:00+08:00' });
  await service.submit({ requestId: 'WT-103', turbine: 'W-1', crew: 'blade-c', risk: 'high', queuedAt: '2026-09-20T08:00:00+08:00' });
  await service.submit({ requestId: 'WT-104', turbine: 'W-2', crew: 'blade-d', risk: 'routine', queuedAt: '2026-09-20T06:00:00+08:00' });
  // blade-c 也申请 W-2，但它将在 W-1 持有窗口 -> W-2 候补时会被跳过
  await service.submit({ requestId: 'WT-105', turbine: 'W-2', crew: 'blade-c', risk: 'critical', queuedAt: '2026-09-20T05:00:00+08:00' });

  const result = await service.cancelBatch({ requestIds: ['WT-101', 'WT-102', 'WT-999'] });
  assert.deepEqual(result.cancelled.map((c) => c.requestId), ['WT-101', 'WT-102']);
  assert.equal(result.errors[0].code, 'not-found');
  assert.equal(result.errors[0].requestId, 'WT-999');

  // W-1 空出 2 个位置：WT-103(high) 锁定；没有其他候补。W-2 无释放。
  assert.deepEqual(result.promotion.granted.map((g) => g.requestId), ['WT-103']);
  assert.equal(service.getTurbine('W-1').occupancy, 1);

  // 再释放 W-2：WT-105 此时被跳过（blade-c 已在 W-1 持窗）
  const w2 = await service.cancel('WT-104');
  assert.deepEqual(w2.promotion.granted, []);
  assert.deepEqual(w2.promotion.skipped[0].reason, 'crew-already-held');
  assert.equal(w2.promotion.skipped[0].busyTurbine, 'W-1');
  assert.equal(service.getTurbine('W-2').occupancy, 0);
});

test('重复提交同一命令（同 eventId）不会重复生效', async () => {
  const service = await makeService();
  await bootstrap(service);
  const first = await service.submit({ requestId: 'WT-201', turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' });
  assert.equal(first.request.state, 'window-held');
  await assert.rejects(
    () => service.submit({ requestId: 'WT-201', version: 1, turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' }),
    (error) => error instanceof ApiError && error.code === 'version-conflict',
  );
  assert.equal(service.getTurbine('W-1').occupancy, 1);
});

test('审批与完成流转', async () => {
  const service = await makeService();
  await bootstrap(service);
  await service.submit({ requestId: 'WT-301', turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' });
  const approved = await service.approve('WT-301');
  assert.equal(approved.request.state, 'approved');
  await assert.rejects(() => service.approve('WT-301'), (e) => e.code === 'invalid-state');
  const done = await service.complete('WT-301');
  assert.equal(done.request.state, 'completed');
  assert.equal(service.getTurbine('W-1').occupancy, 0); // 完成释放容量
});

test('重启重放：占用数、递补顺序与事件序列完全一致', async () => {
  const service = await makeService();
  await bootstrap(service);
  await service.submit({ requestId: 'WT-401', turbine: 'W-1', crew: 'blade-a', risk: 'routine', queuedAt: '2026-09-20T06:00:00+08:00' });
  await service.submit({ requestId: 'WT-402', turbine: 'W-1', crew: 'blade-b', risk: 'critical', queuedAt: '2026-09-20T09:00:00+08:00' });
  await service.submit({ requestId: 'WT-403', turbine: 'W-1', crew: 'blade-c', risk: 'high', queuedAt: '2026-09-20T08:00:00+08:00' });
  await service.reschedule('WT-403', { risk: 'critical' });
  await service.cancelBatch({ requestIds: ['WT-401'] });
  await service.approve('WT-403');

  const eventsBefore = await service.getEvents();
  const snapshotBefore = service.getState();

  // 用同一个日志文件新建服务实例 = 模拟重启
  const dataFile = service.store.filePath;
  const restarted = new SchedulingService(new EventStore(dataFile), { now: () => clock.now() });
  await restarted.load();

  assert.deepEqual(await restarted.getEvents(), eventsBefore);
  assert.deepEqual(restarted.getState(), snapshotBefore);

  const w1 = restarted.getTurbine('W-1');
  assert.equal(w1.capacity, 2);
  assert.equal(w1.occupancy, 2);
  assert.deepEqual(w1.held.map((r) => `${r.requestId}#v${r.version}:${r.state}`), [
    'WT-403#v2:approved',
    'WT-402#v1:window-held',
  ]);
});

test('乱序写入日志（held 早于 submit）重放后不产生负容量', async () => {
  const service = await makeService();
  await bootstrap(service);
  const dataFile = service.store.filePath;
  // 直接往日志写乱序行：held 在 submit 之前
  const lines = [
    { eventId: 'held:WT-501:v1', type: 'window-held', timestamp: 'x', requestId: 'WT-501', version: 1, turbine: 'W-1' },
    { eventId: 'submit:WT-501:v1', type: 'request-submitted', timestamp: 'x', requestId: 'WT-501', version: 1, turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' },
  ];
  await service.store.append(lines);
  const restarted = new SchedulingService(new EventStore(dataFile));
  await restarted.load();
  const w1 = restarted.getTurbine('W-1');
  assert.ok(w1.occupancy >= 0 && w1.occupancy <= w1.capacity);
  assert.deepEqual(w1.held, []); // 乱序 held 未生效，申请仍在候补
});
