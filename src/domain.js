// 纯领域逻辑：状态折叠（事件溯源）+ 确定性候补递补。
// 不做任何 I/O，便于测试与重启重放。

export const requestStates = [
  'submitted',      // 已提交，候补队列中
  'window-held',    // 已锁定当天窗口（递补成功）
  'approved',       // 窗口已审批确认
  'rescheduled',    // 旧版本，因改期失效，永不回到候补队列
  'cancelled',      // 已取消
  'completed',      // 已完成
];

export const riskOrder = { critical: 3, high: 2, routine: 1 };

// 被跳过的具体理由（调度员可见）
export const skipReasons = [
  'superseded-version',  // 已被新版本取代的旧版本
  'crew-already-held',   // 班组在另一台风机上持有窗口
];

export const HOLD_STATES = new Set(['window-held', 'approved']);
const TERMINAL_STATES = new Set(['rescheduled', 'cancelled', 'completed']);

const recordKey = (requestId, version) => `${requestId}#${version}`;

export function createState() {
  return {
    eventIds: new Set(),          // 幂等去重
    turbines: new Map(),          // turbineId -> { turbineId, capacity }
    crews: new Set(),             // crewId
    records: new Map(),           // "requestId#version" -> 申请版本记录
    latest: new Map(),            // requestId -> 当前版本号
  };
}

export function cloneState(state) {
  return {
    eventIds: new Set(state.eventIds),
    turbines: new Map([...state.turbines].map(([id, t]) => [id, { ...t }])),
    crews: new Set(state.crews),
    records: new Map([...state.records].map(([key, rec]) => [key, { ...rec }])),
    latest: new Map(state.latest),
  };
}

/**
 * 把单个事件折叠进状态。
 * 对乱序/重复事件保持防御：
 * - 相同 eventId 的事件只生效一次；
 * - 所有状态迁移都有前置状态校验，非法迁移被忽略；
 * - 占用数由记录状态派生，结构上不可能出现负值。
 */
export function foldEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const { eventId, type } = event;
  if (!eventId || !type) return state;
  if (state.eventIds.has(eventId)) return state;

  const rec = () => state.records.get(recordKey(event.requestId, Number(event.version)));

  switch (type) {
    case 'turbine-registered': {
      const capacity = Number(event.capacity);
      if (!state.turbines.has(event.turbineId) &&
          Number.isInteger(capacity) && capacity > 0) {
        state.turbines.set(event.turbineId, { turbineId: event.turbineId, capacity });
      }
      break;
    }
    case 'crew-registered':
      state.crews.add(event.crewId);
      break;
    case 'request-submitted': {
      const version = Number(event.version);
      const key = recordKey(event.requestId, version);
      if (state.records.has(key)) break;
      state.records.set(key, {
        requestId: event.requestId,
        version,
        turbine: event.turbine,
        crew: event.crew,
        risk: event.risk,
        queuedAt: event.queuedAt,
        state: 'submitted',
      });
      const current = state.latest.get(event.requestId);
      if (current === undefined || version > current) state.latest.set(event.requestId, version);
      break;
    }
    case 'request-superseded': {
      const item = rec();
      if (item && (item.state === 'submitted' || HOLD_STATES.has(item.state))) {
        item.state = 'rescheduled';
      }
      break;
    }
    case 'request-cancelled': {
      const item = rec();
      if (item && (item.state === 'submitted' || HOLD_STATES.has(item.state))) {
        item.state = 'cancelled';
      }
      break;
    }
    case 'window-held': {
      const item = rec();
      // 只有当前提交版本能锁定窗口；旧版本/终态版本不能
      if (item && item.state === 'submitted' &&
          state.latest.get(item.requestId) === item.version) {
        item.state = 'window-held';
      }
      break;
    }
    case 'window-approved': {
      const item = rec();
      if (item && item.state === 'window-held') item.state = 'approved';
      break;
    }
    case 'window-completed': {
      const item = rec();
      if (item && HOLD_STATES.has(item.state)) item.state = 'completed';
      break;
    }
    default:
      break;
  }

  state.eventIds.add(eventId);
  return state;
}

export function occupancy(state, turbineId) {
  let count = 0;
  for (const rec of state.records.values()) {
    if (rec.turbine === turbineId && HOLD_STATES.has(rec.state)) count += 1;
  }
  return count;
}

function crewHoldsElsewhere(state, crewId, requestId) {
  for (const rec of state.records.values()) {
    if (rec.crew === crewId && rec.requestId !== requestId && HOLD_STATES.has(rec.state)) {
      return rec;
    }
  }
  return null;
}

/**
 * 确定性排序：风险等级降序；风险相同保留最初排队时间（升序）；
 * 再以 requestId、version 兜底，保证任意进程重放结果一致。
 */
export function compareRequests(a, b) {
  const byRisk = riskOrder[b.risk] - riskOrder[a.risk];
  if (byRisk !== 0) return byRisk;
  const byTime = Date.parse(a.queuedAt) - Date.parse(b.queuedAt);
  if (byTime !== 0) return byTime;
  const byId = a.requestId.localeCompare(b.requestId);
  if (byId !== 0) return byId;
  return a.version - b.version;
}

export function requestView(rec) {
  return {
    requestId: rec.requestId,
    version: rec.version,
    turbine: rec.turbine,
    crew: rec.crew,
    risk: rec.risk,
    queuedAt: rec.queuedAt,
    state: rec.state,
  };
}

/**
 * 单台风机的递补：扫描候选项（含旧版本，用于给出跳过理由），
 * 每锁定一个窗口才消耗一个空位 —— 一次释放最多交给一个当前有效申请。
 * 返回生成的 window-held 事件（由调用方持久化）以及递补/跳过清单。
 */
export function pumpTurbine(state, turbineId, timestamp) {
  const granted = [];
  const skipped = [];
  const events = [];
  const turbine = state.turbines.get(turbineId);
  if (!turbine) return { granted, skipped, events };

  const reported = new Set();
  const addSkipped = (rec, reason, extra = {}) => {
    const key = recordKey(rec.requestId, rec.version);
    if (reported.has(key)) return;
    reported.add(key);
    skipped.push({
      requestId: rec.requestId,
      version: rec.version,
      turbine: rec.turbine,
      reason,
      ...extra,
    });
  };

  // 候补版本。旧版本一律处于 rescheduled，结构上不可能回到候补队列；
  // submitted 但已非当前版本的记录（如乱序重放）会被识别并给出跳过理由。
  const considered = [...state.records.values()]
    .filter((rec) => rec.turbine === turbineId && rec.state === 'submitted')
    .sort(compareRequests);

  for (const rec of considered) {
    if (occupancy(state, turbineId) >= turbine.capacity) break;

    if (rec.state === 'rescheduled' ||
        rec.version !== state.latest.get(rec.requestId)) {
      addSkipped(rec, 'superseded-version');
      continue;
    }
    const busy = crewHoldsElsewhere(state, rec.crew, rec.requestId);
    if (busy) {
      addSkipped(rec, 'crew-already-held', {
        busyTurbine: busy.turbine,
        busyRequestId: busy.requestId,
        busyVersion: busy.version,
      });
      continue;
    }

    const event = {
      eventId: `held:${rec.requestId}:v${rec.version}`,
      type: 'window-held',
      timestamp,
      requestId: rec.requestId,
      version: rec.version,
      turbine: rec.turbine,
    };
    events.push(event);
    foldEvent(state, event);
    granted.push(requestView(rec));
  }

  return { granted, skipped, events };
}

/**
 * 一次命令处理结束后按固定顺序（turbineId 排序）对所有风机补位，
 * 保证“空位与有效候补不共存”，且事件序列在重放时逐字节一致。
 */
export function pumpAll(state, timestamp) {
  const granted = [];
  const skipped = [];
  const events = [];
  for (const turbineId of [...state.turbines.keys()].sort()) {
    const result = pumpTurbine(state, turbineId, timestamp);
    granted.push(...result.granted);
    skipped.push(...result.skipped);
    events.push(...result.events);
  }
  return { granted, skipped, events };
}

/** 某申请的全部版本视图。 */
export function getRequest(state, requestId) {
  const version = state.latest.get(requestId);
  if (version === undefined) return null;
  const versions = [...state.records.values()]
    .filter((rec) => rec.requestId === requestId)
    .sort((a, b) => a.version - b.version)
    .map(requestView);
  return { requestId, currentVersion: version, current: versions.at(-1), versions };
}

/** 确定性快照：重启重放后应逐字段相等。 */
export function snapshot(state) {
  const turbines = [...state.turbines.keys()].sort().map((turbineId) => {
    const turbine = state.turbines.get(turbineId);
    const records = [...state.records.values()].filter((rec) => rec.turbine === turbineId);
    const held = records
      .filter((rec) => HOLD_STATES.has(rec.state))
      .sort(compareRequests)
      .map(requestView);
    const queue = records
      .filter((rec) => rec.state === 'submitted' &&
        rec.version === state.latest.get(rec.requestId))
      .sort(compareRequests)
      .map(requestView);
    return {
      turbineId,
      capacity: turbine.capacity,
      occupancy: held.length,
      available: turbine.capacity - held.length,
      held,
      queue,
    };
  });
  const requests = [...state.latest.keys()].sort()
    .map((id) => getRequest(state, id));
  return { turbines, crews: [...state.crews].sort(), requests };
}
