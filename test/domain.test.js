import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  foldEvent,
  pumpAll,
  pumpTurbine,
  occupancy,
  compareRequests,
  requestStates,
  riskOrder,
} from '../src/domain.js';

const T = '2026-09-21T08:00:00+08:00';
let seq = 0;
const ts = () => `2026-09-21T08:${String(seq++).padStart(2, '0')}:00+08:00`;

function setup(turbineId, capacity) {
  const state = createState();
  foldEvent(state, { eventId: `t:${turbineId}`, type: 'turbine-registered', timestamp: T, turbineId, capacity });
  return state;
}

function addCrew(state, crewId) {
  foldEvent(state, { eventId: `c:${crewId}`, type: 'crew-registered', timestamp: T, crewId });
}

function submit(state, { requestId, version = 1, turbine, crew, risk, queuedAt }) {
  foldEvent(state, {
    eventId: `s:${requestId}:v${version}`,
    type: 'request-submitted', timestamp: T,
    requestId, version, turbine, crew, risk, queuedAt,
  });
}

function statesOf(state, requestId) {
  return [...state.records.values()]
    .filter((rec) => rec.requestId === requestId)
    .sort((a, b) => a.version - b.version)
    .map((rec) => rec.state);
}

test('领域常量完整', () => {
  assert.deepEqual(requestStates, ['submitted', 'window-held', 'approved', 'rescheduled', 'cancelled', 'completed']);
  assert.deepEqual(Object.keys(riskOrder), ['critical', 'high', 'routine']);
});

test('排序：风险降序，风险相同保留最初排队时间', () => {
  const state = setup('W-1', 2);
  ['a', 'b', 'c', 'd'].forEach(addCrew.bind(null, state));
  submit(state, { requestId: 'R-routine', turbine: 'W-1', crew: 'a', risk: 'routine', queuedAt: '2026-09-21T06:00:00+08:00' });
  submit(state, { requestId: 'R-critical', turbine: 'W-1', crew: 'b', risk: 'critical', queuedAt: '2026-09-21T09:00:00+08:00' });
  submit(state, { requestId: 'R-high-late', turbine: 'W-1', crew: 'c', risk: 'high', queuedAt: '2026-09-21T09:00:00+08:00' });
  submit(state, { requestId: 'R-high-early', turbine: 'W-1', crew: 'd', risk: 'high', queuedAt: '2026-09-21T07:00:00+08:00' });

  const { granted } = pumpAll(state, ts());
  assert.deepEqual(granted.map((item) => item.requestId), ['R-critical', 'R-high-early']);
  assert.equal(occupancy(state, 'W-1'), 2);
});

test('compareRequests 对同风险同时间有确定性兜底', () => {
  const q = '2026-09-21T06:00:00+08:00';
  const a = { requestId: 'B', version: 1, risk: 'high', queuedAt: q };
  const b = { requestId: 'A', version: 1, risk: 'high', queuedAt: q };
  assert.ok(compareRequests(b, a) < 0);
});

test('一次释放只交给一个当前有效申请', () => {
  const state = setup('W-1', 1);
  ['a', 'b', 'c'].forEach(addCrew.bind(null, state));
  submit(state, { requestId: 'R1', turbine: 'W-1', crew: 'a', risk: 'high', queuedAt: '2026-09-21T06:00:00+08:00' });
  submit(state, { requestId: 'R2', turbine: 'W-1', crew: 'b', risk: 'high', queuedAt: '2026-09-21T07:00:00+08:00' });
  submit(state, { requestId: 'R3', turbine: 'W-1', crew: 'c', risk: 'high', queuedAt: '2026-09-21T08:00:00+08:00' });
  pumpAll(state, ts());
  assert.equal(occupancy(state, 'W-1'), 1);

  foldEvent(state, { eventId: 'cancel:R1:v1', type: 'request-cancelled', timestamp: ts(), requestId: 'R1', version: 1 });
  const { granted } = pumpAll(state, ts());
  assert.deepEqual(granted.map((item) => item.requestId), ['R2']);
  assert.equal(occupancy(state, 'W-1'), 1);
});

test('旧版本改期后永不回到候补队列', () => {
  const state = setup('W-1', 1);
  ['a'].forEach(addCrew.bind(null, state));
  submit(state, { requestId: 'R1', turbine: 'W-1', crew: 'a', risk: 'high', queuedAt: '2026-09-21T06:00:00+08:00' });
  pumpAll(state, ts());
  // 改期：v1 失效，v2 以相同排队时间重新候补
  foldEvent(state, { eventId: 'sup:R1:v1', type: 'request-superseded', timestamp: ts(), requestId: 'R1', version: 1 });
  submit(state, { requestId: 'R1', version: 2, turbine: 'W-1', crew: 'a', risk: 'high', queuedAt: '2026-09-21T06:00:00+08:00' });
  pumpAll(state, ts());
  assert.deepEqual(statesOf(state, 'R1'), ['rescheduled', 'window-held']);

  foldEvent(state, { eventId: 'cancel:R1:v2', type: 'request-cancelled', timestamp: ts(), requestId: 'R1', version: 2 });
  const { granted } = pumpAll(state, ts());
  assert.deepEqual(granted, []); // v1 不会复活
  assert.deepEqual(statesOf(state, 'R1'), ['rescheduled', 'cancelled']);
});

test('班组已在别处持有窗口时跳过并给出理由', () => {
  const state = createState();
  foldEvent(state, { eventId: 't:A', type: 'turbine-registered', timestamp: T, turbineId: 'A', capacity: 1 });
  foldEvent(state, { eventId: 't:B', type: 'turbine-registered', timestamp: T, turbineId: 'B', capacity: 1 });
  addCrew(state, 'crew-x');
  addCrew(state, 'crew-y');
  submit(state, { requestId: 'RA', turbine: 'A', crew: 'crew-x', risk: 'critical', queuedAt: '2026-09-21T06:00:00+08:00' });
  submit(state, { requestId: 'RB', turbine: 'B', crew: 'crew-x', risk: 'critical', queuedAt: '2026-09-21T06:30:00+08:00' });
  submit(state, { requestId: 'RC', turbine: 'B', crew: 'crew-y', risk: 'routine', queuedAt: '2026-09-21T09:00:00+08:00' });
  // 按 turbineId 顺序递补：A 先锁定 crew-x；B 跳过 crew-x，交给 crew-y
  const { granted, skipped } = pumpAll(state, ts());
  assert.deepEqual(granted.map((item) => item.requestId), ['RA', 'RC']);
  assert.deepEqual(skipped, [{
    requestId: 'RB', version: 1, turbine: 'B', reason: 'crew-already-held',
    busyTurbine: 'A', busyRequestId: 'RA', busyVersion: 1,
  }]);
});

test('乱序与重复事件不产生负容量或双重锁定', () => {
  const state = setup('W-1', 1);
  addCrew(state, 'a');
  // window-held 早于 submitted（乱序注入）：不能生效
  foldEvent(state, { eventId: 'rogue-held:R1:v1', type: 'window-held', timestamp: T, requestId: 'R1', version: 1 });
  submit(state, { requestId: 'R1', turbine: 'W-1', crew: 'a', risk: 'high', queuedAt: '2026-09-21T06:00:00+08:00' });
  // 再次投递同一个乱序事件：仍不能把未候补的版本锁定
  foldEvent(state, { eventId: 'rogue-held:R1:v1', type: 'window-held', timestamp: T, requestId: 'R1', version: 1 });
  const before = pumpAll(state, ts());
  assert.equal(before.granted.length, 1);
  assert.ok(occupancy(state, 'W-1') >= 0 && occupancy(state, 'W-1') <= 1);

  // 重复取消事件只生效一次
  const cancel = { eventId: 'cancel:R1:v1', type: 'request-cancelled', timestamp: ts(), requestId: 'R1', version: 1 };
  foldEvent(state, cancel);
  foldEvent(state, { ...cancel }); // 同 eventId
  pumpAll(state, ts());
  assert.equal(occupancy(state, 'W-1'), 0);

  // 已取消版本不能通过乱序 held 事件重新锁定
  foldEvent(state, { eventId: 'rogue-held2:R1:v1', type: 'window-held', timestamp: T, requestId: 'R1', version: 1 });
  assert.equal(occupancy(state, 'W-1'), 0);
});

test('容量为 2 时两个释放递补两个、不超发', () => {
  const state = setup('W-1', 2);
  ['a', 'b', 'c', 'd'].forEach(addCrew.bind(null, state));
  for (const [id, crew, hour] of [['R1', 'a', 6], ['R2', 'b', 7], ['R3', 'c', 8], ['R4', 'd', 9]]) {
    submit(state, { requestId: id, turbine: 'W-1', crew, risk: 'routine', queuedAt: `2026-09-21T0${hour}:00:00+08:00` });
  }
  pumpAll(state, ts());
  assert.equal(occupancy(state, 'W-1'), 2);
  foldEvent(state, { eventId: 'cancel:R1:v1', type: 'request-cancelled', timestamp: ts(), requestId: 'R1', version: 1 });
  foldEvent(state, { eventId: 'cancel:R2:v1', type: 'request-cancelled', timestamp: ts(), requestId: 'R2', version: 1 });
  const { granted } = pumpTurbine(state, 'W-1', ts());
  assert.deepEqual(granted.map((item) => item.requestId), ['R3', 'R4']);
  assert.equal(occupancy(state, 'W-1'), 2);
});
