import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { EventStore } from '../src/store.js';

const T0 = '2026-09-20T06:00:00+08:00';
const T1 = '2026-09-20T06:30:00+08:00';
const T2 = '2026-09-20T07:00:00+08:00';
const T3 = '2026-09-20T08:00:00+08:00';
const T4 = '2026-09-20T09:00:00+08:00';

async function startServer(dir) {
  const store = new EventStore(dir, { capacity: 1 });
  const server = buildServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { store, server, base: `http://127.0.0.1:${port}` };
}

async function stopServer({ server, store }) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  store.close();
}

async function post(base, pathName, body) {
  const response = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, pathName) {
  const response = await fetch(base + pathName);
  return { status: response.status, body: await response.json() };
}

test('批量取消后立即看到递补班组与跳过理由，重启后状态一致', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wind-server-'));
  let running = await startServer(dir);
  try {
    await post(running.base, '/capacity', { capacity: 2 });
    const a = await post(running.base, '/requests', { requestId: 'A', turbine: 'W-1', crew: 'blade-a', risk: 'critical', queuedAt: T1 });
    assert.deepEqual(a.body.promotions.map((item) => item.requestId), ['A']);
    const c = await post(running.base, '/requests', { requestId: 'C', turbine: 'W-3', crew: 'blade-b', risk: 'routine', queuedAt: T3 });
    assert.deepEqual(c.body.promotions.map((item) => item.requestId), ['C']);
    // 容量已满（A、C 在窗），E、B、D 进入候补
    const e = await post(running.base, '/requests', { requestId: 'E', turbine: 'W-5', crew: 'blade-b', risk: 'high', queuedAt: T0 });
    assert.equal(e.body.state, 'submitted');
    const b = await post(running.base, '/requests', { requestId: 'B', turbine: 'W-2', crew: 'blade-a', risk: 'high', queuedAt: T2 });
    assert.equal(b.body.state, 'submitted');
    await post(running.base, '/requests', { requestId: 'D', turbine: 'W-4', crew: 'blade-c', risk: 'high', queuedAt: T4 });

    const batch = await post(running.base, '/cancellations', {
      items: [
        { requestId: 'A', version: 1 },
        { requestId: 'C', version: 1 },
        { requestId: 'A', version: 1 }, // 重复项：幂等拒绝，不重复释放
      ],
    });
    assert.equal(batch.status, 200);
    assert.deepEqual(
      batch.body.items.map((item) => [item.requestId, item.accepted, item.reason ?? null]),
      [['A', true, null], ['C', true, null], ['A', false, 'already-cancelled']],
    );
    // 取消 A：E 仍被 blade-b(C) 阻塞而跳过，B 递补；取消 C：E 递补
    assert.deepEqual(batch.body.promotions.map((item) => [item.requestId, item.crew]), [['B', 'blade-a'], ['E', 'blade-b']]);
    assert.deepEqual(batch.body.skipped.map((item) => [item.requestId, item.reason]), [['E', 'crew-window-held']]);
    assert.equal(batch.body.occupancy, 2);

    const state = (await get(running.base, '/state')).body;
    assert.deepEqual(state.holders.map((item) => item.requestId), ['B', 'E']);
    assert.deepEqual(state.waitlist.map((item) => item.requestId), ['D']);

    await stopServer(running);
    running = await startServer(dir); // 模拟服务重启
    const restored = (await get(running.base, '/state')).body;
    assert.deepEqual(restored.holders, state.holders);
    assert.deepEqual(restored.waitlist, state.waitlist);
    assert.equal(restored.occupancy, state.occupancy);
    const replay = await post(running.base, '/debug/replay', {});
    assert.equal(replay.body.ok, true);
  } finally {
    await stopServer(running);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('参数校验与领域拒绝的状态码', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wind-server-'));
  const running = await startServer(dir);
  try {
    assert.equal((await get(running.base, '/')).body.service, 'wind-maintenance');
    assert.equal((await post(running.base, '/requests', { requestId: 'X', turbine: 'W-1', crew: 'c', risk: 'extreme' })).status, 400);
    const badJson = await fetch(`${running.base}/requests`, { method: 'POST', body: '{oops' });
    assert.equal(badJson.status, 400);
    assert.equal((await get(running.base, '/requests/NOPE')).status, 404);
    assert.equal((await post(running.base, '/requests/NOPE/cancel', { version: 1 })).status, 404);

    await post(running.base, '/requests', { requestId: 'X', turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: T1 });
    const rescheduled = await post(running.base, '/requests/X/reschedule', { baseVersion: 1, risk: 'critical' });
    assert.equal(rescheduled.status, 200);
    assert.equal(rescheduled.body.version, 2);
    const stale = await post(running.base, '/requests/X/cancel', { version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, 'stale-version');
    assert.equal(stale.body.occupancy, 1); // 乱序取消没有释放容量

    const first = await post(running.base, '/requests', { requestId: 'Y', turbine: 'W-2', crew: 'blade-b', risk: 'low', queuedAt: T2, eventId: 'evt-y' });
    assert.equal(first.status, 400); // risk 不在枚举内
    const ok = await post(running.base, '/requests', { requestId: 'Y', turbine: 'W-2', crew: 'blade-b', risk: 'routine', queuedAt: T2, eventId: 'evt-y' });
    assert.equal(ok.status, 200);
    const dup = await post(running.base, '/requests', { requestId: 'Y', turbine: 'W-2', crew: 'blade-b', risk: 'routine', queuedAt: T2, eventId: 'evt-y' });
    assert.equal(dup.body.duplicate, true);
    const state = (await get(running.base, '/state')).body;
    assert.deepEqual(Object.keys(state.requests).sort(), ['X', 'Y']);
  } finally {
    await stopServer(running);
    rmSync(dir, { recursive: true, force: true });
  }
});
