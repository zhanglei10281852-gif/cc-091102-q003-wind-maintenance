import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'wind-api-'));
process.env.EVENT_LOG = join(dataDir, 'events.jsonl');
process.env.PORT = '0';

const { server, start } = await import('../src/server.js');
const { port } = await start();
const base = `http://127.0.0.1:${port}`;

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

test('健康检查', async () => {
  const { status, json } = await call('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'running');
});

test('完整调度流程经 HTTP 工作', async () => {
  const { status: t1 } = await call('POST', '/turbines', { turbineId: 'W-1', capacity: 1 });
  assert.equal(t1, 200);
  const dup = await call('POST', '/turbines', { turbineId: 'W-1', capacity: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'turbine-exists');

  const badCap = await call('POST', '/turbines', { turbineId: 'W-x', capacity: 0 });
  assert.equal(badCap.status, 400);

  await call('POST', '/crews', { crewId: 'blade-a' });
  await call('POST', '/crews', { crewId: 'blade-b' });

  const s1 = await call('POST', '/requests', { requestId: 'WT-A', turbine: 'W-1', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' });
  assert.equal(s1.json.request.state, 'window-held');

  const s2 = await call('POST', '/requests', { requestId: 'WT-B', turbine: 'W-1', crew: 'blade-b', risk: 'critical', queuedAt: '2026-09-20T09:00:00+08:00' });
  assert.equal(s2.json.request.state, 'submitted'); // 容量已满

  // 未知风机/班组被拒绝
  const bad = await call('POST', '/requests', { requestId: 'WT-X', turbine: 'NOPE', crew: 'blade-a', risk: 'high', queuedAt: '2026-09-20T06:00:00+08:00' });
  assert.equal(bad.status, 422);

  // 取消后 WT-B（critical）立即递补
  const cancelled = await call('POST', '/requests/WT-A/cancel');
  assert.deepEqual(cancelled.json.promotion.granted.map((g) => g.requestId), ['WT-B']);

  const w1 = await call('GET', '/turbines/W-1');
  assert.equal(w1.json.occupancy, 1);
  assert.deepEqual(w1.json.held.map((r) => r.requestId), ['WT-B']);

  // 改期后旧版本留在 rescheduled，不回候补
  const rs = await call('POST', '/requests/WT-B/reschedule', { risk: 'routine' });
  assert.equal(rs.json.request.version, 2);
  assert.equal(rs.json.request.queuedAt, '2026-09-20T09:00:00+08:00'); // 保留最初排队时间
  const detail = await call('GET', '/requests/WT-B');
  assert.deepEqual(detail.json.versions.map((v) => v.state), ['rescheduled', 'window-held']);
});

test('批量取消接口返回获得窗口班组与跳过理由', async () => {
  await call('POST', '/turbines', { turbineId: 'W-9', capacity: 1 });
  await call('POST', '/crews', { crewId: 'crew-9' });
  const held = await call('POST', '/requests', { requestId: 'WT-900', turbine: 'W-9', crew: 'crew-9', risk: 'routine', queuedAt: '2026-09-20T06:00:00+08:00' });
  assert.equal(held.json.request.state, 'window-held');

  const result = await call('POST', '/cancel-batch', { requestIds: ['WT-900', 'WT-MISSING'] });
  assert.deepEqual(result.json.cancelled.map((c) => c.requestId), ['WT-900']);
  assert.equal(result.json.errors[0].code, 'not-found');
  assert.deepEqual(result.json.promotion.granted, []);
});

test('非法 JSON 与未知路由', async () => {
  const response = await fetch(`${base}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(response.status, 400);
  const nf = await call('GET', '/nope');
  assert.equal(nf.status, 404);
});

test('事件列表可查询', async () => {
  const { json } = await call('GET', '/events');
  assert.ok(Array.isArray(json.events));
  assert.ok(json.events.length > 5);
  assert.ok(json.events.every((event) => typeof event.eventId === 'string'));
});
