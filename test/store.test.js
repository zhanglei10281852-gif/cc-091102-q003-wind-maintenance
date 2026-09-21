import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countHolders, holders, rankWaitlist } from '../src/domain.js';
import { EventStore } from '../src/store.js';

const T1 = '2026-09-20T06:30:00+08:00';
const T2 = '2026-09-20T07:00:00+08:00';
const T3 = '2026-09-20T08:00:00+08:00';

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'wind-store-'));
}

function scenario(store) {
  store.apply('capacity-set', { capacity: 2 });
  store.apply('request-submitted', { requestId: 'WT-1', turbine: 'W-1', crew: 'crew-a', risk: 'critical', queuedAt: T1 });
  store.apply('request-submitted', { requestId: 'WT-2', turbine: 'W-2', crew: 'crew-b', risk: 'high', queuedAt: T2 });
  store.apply('request-submitted', { requestId: 'WT-3', turbine: 'W-3', crew: 'crew-c', risk: 'routine', queuedAt: T3 });
  store.apply('request-rescheduled', { requestId: 'WT-3', baseVersion: 1, risk: 'high' });
  store.apply('request-locked', { requestId: 'WT-1', version: 1 });
  store.apply('request-cancelled', { requestId: 'WT-2', version: 1 });
  store.apply('request-completed', { requestId: 'WT-1', version: 1 });
  store.apply('batch-cancelled', { items: [{ requestId: 'WT-3', version: 2 }] });
}

function view(store) {
  return {
    state: store.state,
    occupancy: countHolders(store.state),
    holders: holders(store.state),
    waitlist: rankWaitlist(store.state),
  };
}

test('重启重放后占用数与递补顺序完全一致', () => {
  const dir = tempDir();
  try {
    const first = new EventStore(dir, { capacity: 1 });
    scenario(first);
    const before = view(first);
    assert.equal(first.verify().ok, true);
    first.close();

    const second = new EventStore(dir, { capacity: 1 });
    const after = view(second);
    assert.deepEqual(after, before);
    assert.equal(second.verify().ok, true);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eventId 幂等：重复投递返回首次结果且不重复落盘', () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir);
    const payload = { requestId: 'WT-1', turbine: 'W-1', crew: 'crew-a', risk: 'high', queuedAt: T1 };
    const first = store.apply('request-submitted', payload, 'evt-1');
    assert.equal(first.accepted, true);
    const again = store.apply('request-submitted', payload, 'evt-1');
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.promotions, first.promotions);
    assert.equal(store.records.length, 1);
    // 没有幂等键的重复提交由结构校验拒绝，同样不会落盘
    const rejected = store.apply('request-submitted', payload);
    assert.equal(rejected.reason, 'duplicate-request');
    assert.equal(store.records.length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('被拒绝的命令不落盘，重试得到同样的拒绝', () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir);
    store.apply('request-submitted', { requestId: 'WT-1', turbine: 'W-1', crew: 'crew-a', risk: 'high', queuedAt: T1 });
    const before = store.records.length;
    const stale = store.apply('request-cancelled', { requestId: 'WT-1', version: 9 });
    assert.equal(stale.accepted, false);
    assert.equal(store.records.length, before);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃留下的半行被忽略，其余日志正常重放', () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir);
    store.apply('request-submitted', { requestId: 'WT-1', turbine: 'W-1', crew: 'crew-a', risk: 'high', queuedAt: T1 });
    const count = store.records.length;
    store.close();
    appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":999,"type":"request-sub');
    const reopened = new EventStore(dir);
    assert.equal(reopened.records.length, count);
    assert.equal(countHolders(reopened.state), 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
