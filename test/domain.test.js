import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent,
  countHolders,
  createState,
  holders,
  rankWaitlist,
} from '../src/domain.js';

const T0 = '2026-09-19T22:30:00Z'; // 与 T1 是同一时刻，用于验证时区解析
const T1 = '2026-09-20T06:30:00+08:00';
const T2 = '2026-09-20T07:00:00+08:00';
const T3 = '2026-09-20T08:00:00+08:00';
const T4 = '2026-09-20T09:00:00+08:00';
const T5 = '2026-09-20T10:00:00+08:00';

function run(state, type, payload) {
  return applyEvent(state, { type, payload });
}

function submit(state, requestId, overrides = {}) {
  return run(state, 'request-submitted', {
    requestId,
    turbine: 'W-1',
    crew: 'crew-a',
    risk: 'routine',
    queuedAt: T1,
    ...overrides,
  });
}

test('风险等级相同时保留最初排队时间，改期不丢位置', () => {
  const state = createState(0);
  submit(state, 'WT-1', { queuedAt: T2 });
  submit(state, 'WT-2', { queuedAt: T1 });
  assert.deepEqual(rankWaitlist(state).map((item) => item.requestId), ['WT-2', 'WT-1']);
  const outcome = run(state, 'request-rescheduled', { requestId: 'WT-2', baseVersion: 1 });
  assert.equal(outcome.accepted, true);
  const waiting = rankWaitlist(state);
  assert.equal(waiting[0].requestId, 'WT-2');
  assert.equal(waiting[0].version, 2);
  assert.equal(waiting[0].queuedAt, T1); // 新版本仍用最初排队时间
});

test('排序按风险优先，排队时间按时刻解析而非字符串', () => {
  const state = createState(0);
  submit(state, 'WT-B', { queuedAt: T1 });
  submit(state, 'WT-A', { queuedAt: T0 }); // 与 T1 同一时刻 → requestId 定序
  submit(state, 'WT-C', { risk: 'critical', queuedAt: T3 }); // 风险最高 → 排最前
  assert.deepEqual(rankWaitlist(state).map((item) => item.requestId), ['WT-C', 'WT-A', 'WT-B']);
});

test('旧版本不得回到候补队列，旧版本命令按乱序拒绝', () => {
  const state = createState(1);
  submit(state, 'WT-1', { risk: 'critical' });
  submit(state, 'WT-2', { risk: 'high', queuedAt: T2 });
  run(state, 'request-rescheduled', { requestId: 'WT-2', baseVersion: 1 });
  const staleCancel = run(state, 'request-cancelled', { requestId: 'WT-2', version: 1 });
  assert.equal(staleCancel.accepted, false);
  assert.equal(staleCancel.reason, 'stale-version');
  assert.equal(staleCancel.currentVersion, 2);
  const staleComplete = run(state, 'request-completed', { requestId: 'WT-2', version: 1 });
  assert.equal(staleComplete.reason, 'stale-version');
  assert.equal(countHolders(state), 1); // WT-1 的窗口不受影响
  assert.deepEqual(rankWaitlist(state).map((item) => `${item.requestId}@${item.version}`), ['WT-2@2']);
});

test('一次释放只交给一个当前有效申请', () => {
  const state = createState(1);
  submit(state, 'WT-1', { risk: 'critical' });
  submit(state, 'WT-2', { risk: 'high', queuedAt: T2 });
  submit(state, 'WT-3', { risk: 'routine', queuedAt: T3 });
  const outcome = run(state, 'request-cancelled', { requestId: 'WT-1', version: 1 });
  assert.equal(outcome.releases, 1);
  assert.equal(outcome.promotions.length, 1);
  assert.equal(outcome.promotions[0].requestId, 'WT-2');
  assert.equal(countHolders(state), 1);
  assert.deepEqual(rankWaitlist(state).map((item) => item.requestId), ['WT-3']);
});

test('重复取消不会重复释放容量，占用数不会变负', () => {
  const state = createState(1);
  submit(state, 'WT-1');
  submit(state, 'WT-2', { crew: 'crew-b', turbine: 'W-2', queuedAt: T2 });
  run(state, 'request-cancelled', { requestId: 'WT-1', version: 1 }); // WT-2 递补
  const dup = run(state, 'request-cancelled', { requestId: 'WT-1', version: 1 });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'already-cancelled');
  assert.equal(countHolders(state), 1);
  run(state, 'request-cancelled', { requestId: 'WT-2', version: 1 });
  assert.equal(countHolders(state), 0);
  const again = run(state, 'request-cancelled', { requestId: 'WT-2', version: 1 });
  assert.equal(again.accepted, false);
  assert.equal(countHolders(state), 0); // 不会变成 -1
});

test('乱序事件：未占窗不能完成或锁定，已取消不能锁定', () => {
  const state = createState(2);
  submit(state, 'WT-1', { crew: 'crew-a', turbine: 'W-1' });
  submit(state, 'WT-2', { crew: 'crew-b', turbine: 'W-2' });
  submit(state, 'WT-3', { crew: 'crew-c', turbine: 'W-3' }); // 容量已满，候补
  assert.equal(run(state, 'request-completed', { requestId: 'WT-3', version: 1 }).reason, 'not-held');
  assert.equal(run(state, 'request-locked', { requestId: 'WT-3', version: 1 }).reason, 'not-held');
  run(state, 'request-cancelled', { requestId: 'WT-1', version: 1 }); // WT-3 递补
  assert.equal(run(state, 'request-locked', { requestId: 'WT-1', version: 1 }).reason, 'not-held');
  assert.equal(countHolders(state), 2);
});

test('班组已持窗的申请被跳过并记录具体理由', () => {
  const state = createState(2);
  submit(state, 'WT-1', { crew: 'crew-a', turbine: 'W-1', risk: 'critical' });
  const blocked = submit(state, 'WT-2', { crew: 'crew-a', turbine: 'W-2', risk: 'high', queuedAt: T2 });
  assert.equal(blocked.skipped[0].reason, 'crew-window-held');
  submit(state, 'WT-3', { crew: 'crew-b', turbine: 'W-3', risk: 'routine', queuedAt: T3 });
  submit(state, 'WT-4', { crew: 'crew-c', turbine: 'W-4', risk: 'routine', queuedAt: T4 });
  const outcome = run(state, 'request-cancelled', { requestId: 'WT-3', version: 1 });
  // WT-2 排名更前但班组 crew-a 仍占窗 → 跳过；WT-4 递补
  assert.deepEqual(outcome.skipped.map((item) => [item.requestId, item.reason]), [['WT-2', 'crew-window-held']]);
  assert.equal(outcome.promotions[0].requestId, 'WT-4');
});

test('同风机已有窗口的申请被跳过', () => {
  const state = createState(2);
  submit(state, 'WT-1', { crew: 'crew-a', turbine: 'W-1', risk: 'critical' });
  const blocked = submit(state, 'WT-2', { crew: 'crew-b', turbine: 'W-1', risk: 'high', queuedAt: T2 });
  assert.equal(blocked.skipped[0].reason, 'turbine-window-held');
  assert.equal(countHolders(state), 1);
});

test('容量调整：扩容立即递补，缩容不驱逐', () => {
  const state = createState(1);
  submit(state, 'WT-1', { risk: 'critical' });
  submit(state, 'WT-2', { crew: 'crew-b', turbine: 'W-2', risk: 'high', queuedAt: T2 });
  const grow = run(state, 'capacity-set', { capacity: 2 });
  assert.equal(grow.promotions[0].requestId, 'WT-2');
  run(state, 'capacity-set', { capacity: 0 });
  assert.equal(countHolders(state), 2); // 缩容不驱逐在窗班组
  const done = run(state, 'request-completed', { requestId: 'WT-1', version: 1 });
  assert.equal(done.promotions.length, 0); // 容量为 0，暂停递补
  assert.equal(countHolders(state), 1);
  assert.equal(run(state, 'capacity-set', { capacity: -1 }).reason, 'invalid-capacity');
});

test('批量取消：逐项校验，汇总递补与跳过理由', () => {
  const state = createState(3);
  submit(state, 'A', { crew: 'crew-a', turbine: 'W-1', risk: 'critical', queuedAt: T1 });
  submit(state, 'B', { crew: 'crew-b', turbine: 'W-2', risk: 'high', queuedAt: T2 });
  submit(state, 'C', { crew: 'crew-c', turbine: 'W-3', risk: 'routine', queuedAt: T3 });
  submit(state, 'D', { crew: 'crew-d', turbine: 'W-4', risk: 'high', queuedAt: T4 });
  submit(state, 'E', { crew: 'crew-e', turbine: 'W-5', risk: 'routine', queuedAt: T5 });
  const outcome = run(state, 'batch-cancelled', {
    items: [
      { requestId: 'A', version: 1 },
      { requestId: 'B', version: 1 },
      { requestId: 'NOPE', version: 1 },
      { requestId: 'C', version: 9 },
    ],
  });
  assert.equal(outcome.accepted, true);
  assert.deepEqual(
    outcome.items.map((item) => [item.requestId, item.accepted, item.reason ?? null]),
    [['A', true, null], ['B', true, null], ['NOPE', false, 'unknown-request'], ['C', false, 'unknown-version']],
  );
  assert.deepEqual(outcome.promotions.map((item) => item.requestId), ['D', 'E']);
  assert.equal(countHolders(state), 3); // C 仍在窗
  const none = run(state, 'batch-cancelled', { items: [{ requestId: 'A', version: 1 }] });
  assert.equal(none.accepted, false);
  assert.equal(none.reason, 'no-items-applied');
});

test('锁定与完成流程', () => {
  const state = createState(1);
  submit(state, 'WT-1');
  assert.equal(state.requests['WT-1'].versions[1].state, 'window-held');
  const locked = run(state, 'request-locked', { requestId: 'WT-1', version: 1 });
  assert.equal(locked.state, 'approved');
  assert.equal(run(state, 'request-locked', { requestId: 'WT-1', version: 1 }).reason, 'already-approved');
  const done = run(state, 'request-completed', { requestId: 'WT-1', version: 1 });
  assert.equal(done.releases, 1);
  assert.equal(run(state, 'request-completed', { requestId: 'WT-1', version: 1 }).reason, 'already-completed');
  assert.equal(countHolders(state), 0);
});

test('改期释放窗口，新版本带最初排队时间重新排队', () => {
  const state = createState(1);
  submit(state, 'WT-1', { crew: 'crew-a', turbine: 'W-1', risk: 'critical', queuedAt: T1 });
  submit(state, 'WT-2', { crew: 'crew-b', turbine: 'W-2', risk: 'critical', queuedAt: T2 });
  const outcome = run(state, 'request-rescheduled', { requestId: 'WT-1', baseVersion: 1, risk: 'routine' });
  assert.equal(outcome.releases, 1);
  // WT-2 风险更高 → 获得窗口；WT-1 v2 以最初排队时间回到候补
  assert.equal(outcome.promotions[0].requestId, 'WT-2');
  assert.deepEqual(holders(state).map((item) => item.requestId), ['WT-2']);
  const waiting = rankWaitlist(state);
  assert.equal(waiting[0].requestId, 'WT-1');
  assert.equal(waiting[0].version, 2);
  assert.equal(waiting[0].queuedAt, T1);
  assert.equal(state.requests['WT-1'].versions[1].state, 'rescheduled'); // 旧版本终态
});
