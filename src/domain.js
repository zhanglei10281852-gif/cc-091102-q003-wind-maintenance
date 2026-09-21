// 领域常量与纯函数规约器：不做任何 I/O，同样的 (state, event) 永远得到同样的结果，
// 这是“重启重放后占用数与递补顺序一致”的基础。

export const requestStates = ['submitted', 'window-held', 'approved', 'rescheduled', 'cancelled', 'completed'];
export const riskOrder = { critical: 3, high: 2, routine: 1 };

// window-held = 已占窗口待锁定；approved = 已锁定（对应调度动作“锁定”）。
const HOLDING_STATES = new Set(['window-held', 'approved']);
// rescheduled = 旧版本被改期取代（终态）；cancelled / completed 同为终态。
const TERMINAL_STATES = new Set(['rescheduled', 'cancelled', 'completed']);

export function isRisk(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(riskOrder, value);
}

export function createState(capacity = 1) {
  return { capacity, requests: {} };
}

function getRequest(state, requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(state.requests, requestId) ? state.requests[requestId] : null;
}

function currentRecord(request) {
  return request.versions[request.currentVersion] ?? null;
}

// 当前占用窗口的版本（window-held / approved）。占用数永远从这里派生，
// 不存在可被重复扣减的计数器，因此结构上不可能出现负容量。
export function holders(state) {
  const list = [];
  for (const request of Object.values(state.requests)) {
    for (const record of Object.values(request.versions)) {
      if (HOLDING_STATES.has(record.state)) {
        list.push({
          requestId: request.requestId,
          version: record.version,
          crew: request.crew,
          turbine: request.turbine,
          risk: record.risk,
          queuedAt: record.queuedAt,
          state: record.state,
        });
      }
    }
  }
  return list.sort((a, b) => (a.requestId === b.requestId
    ? a.version - b.version
    : (a.requestId < b.requestId ? -1 : 1)));
}

export function countHolders(state) {
  return holders(state).length;
}

// 确定性排序：风险等级高者优先；风险相同时保留最初排队时间（改期不改变 queuedAt）；
// 再相同则按 requestId、version 字典序，保证任意重放下顺序一致。
export function compareCandidates(a, b) {
  const byRisk = riskOrder[b.risk] - riskOrder[a.risk];
  if (byRisk !== 0) return byRisk;
  const byQueuedAt = Date.parse(a.queuedAt) - Date.parse(b.queuedAt);
  if (byQueuedAt !== 0) return byQueuedAt;
  if (a.requestId !== b.requestId) return a.requestId < b.requestId ? -1 : 1;
  return a.version - b.version;
}

// 候补队列只取“最新版本且仍处于 submitted”的记录：旧版本在改期时被置为
// rescheduled 终态，因此旧版本不可能回到候补队列。
export function rankWaitlist(state) {
  const waiting = [];
  for (const request of Object.values(state.requests)) {
    const record = currentRecord(request);
    if (record && record.state === 'submitted') {
      waiting.push({
        requestId: request.requestId,
        version: record.version,
        crew: request.crew,
        turbine: request.turbine,
        risk: record.risk,
        queuedAt: record.queuedAt,
      });
    }
  }
  return waiting.sort(compareCandidates);
}

function skipKey(item) {
  return `${item.requestId}@${item.version}:${item.reason}`;
}

// 扫描一次候补队列：跳过有冲突的申请（记录具体理由），把窗口交给排名最前的
// 当前有效申请。一次调用至多递补一个 —— 一次释放只能交给一个当前有效申请。
function promoteOnce(state) {
  const held = holders(state);
  const busyCrews = new Set(held.map((item) => item.crew));
  const busyTurbines = new Set(held.map((item) => item.turbine));
  const skipped = [];
  for (const candidate of rankWaitlist(state)) {
    if (busyCrews.has(candidate.crew)) {
      skipped.push({ ...candidate, reason: 'crew-window-held' });
      continue;
    }
    if (busyTurbines.has(candidate.turbine)) {
      skipped.push({ ...candidate, reason: 'turbine-window-held' });
      continue;
    }
    const request = getRequest(state, candidate.requestId);
    request.versions[candidate.version].state = 'window-held';
    return { promoted: { ...candidate, state: 'window-held' }, skipped };
  }
  return { promoted: null, skipped };
}

// 只要还有空位就逐个递补；每个空位至多交给一个申请。
function settle(state, outcome) {
  const seen = new Set(outcome.skipped.map(skipKey));
  while (countHolders(state) < state.capacity) {
    const { promoted, skipped } = promoteOnce(state);
    for (const item of skipped) {
      const key = skipKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        outcome.skipped.push(item);
      }
    }
    if (!promoted) return;
    outcome.promotions.push(promoted);
  }
}

function reject(reason, extra = {}) {
  return { accepted: false, reason, promotions: [], skipped: [], ...extra };
}

function accept(extra = {}) {
  return { accepted: true, promotions: [], skipped: [], ...extra };
}

// 版本精确校验：乱序到达的旧版本命令（如改期后迟到的取消）会被拒绝，
// 不会误伤当前版本，也不会错误释放容量。
function requireCurrentVersion(state, requestId, version) {
  const request = getRequest(state, requestId);
  if (!request) return { error: reject('unknown-request') };
  if (!Number.isInteger(version) || version < 1) return { error: reject('invalid-version') };
  if (version !== request.currentVersion) {
    return {
      error: reject(version < request.currentVersion ? 'stale-version' : 'unknown-version', {
        currentVersion: request.currentVersion,
      }),
    };
  }
  return { request, record: request.versions[version] };
}

function applyCapacitySet(state, payload) {
  const { capacity } = payload;
  if (!Number.isInteger(capacity) || capacity < 0) return reject('invalid-capacity');
  state.capacity = capacity;
  const outcome = accept({ capacity });
  settle(state, outcome); // 扩容后立即按序递补；缩容不驱逐，仅暂停后续递补
  return outcome;
}

function applySubmit(state, payload) {
  const { requestId, turbine, crew, risk, queuedAt } = payload;
  if (typeof requestId !== 'string' || requestId.length === 0) return reject('invalid-request-id');
  if (getRequest(state, requestId)) return reject('duplicate-request');
  if (typeof turbine !== 'string' || turbine.length === 0) return reject('invalid-turbine');
  if (typeof crew !== 'string' || crew.length === 0) return reject('invalid-crew');
  if (!isRisk(risk)) return reject('invalid-risk');
  if (typeof queuedAt !== 'string' || Number.isNaN(Date.parse(queuedAt))) return reject('invalid-queued-at');
  state.requests[requestId] = {
    requestId,
    turbine,
    crew,
    currentVersion: 1,
    versions: { 1: { version: 1, risk, queuedAt, state: 'submitted' } },
  };
  const outcome = accept({ requestId, version: 1 });
  settle(state, outcome); // 有空位时立即自动递补
  outcome.state = state.requests[requestId].versions[1].state;
  return outcome;
}

function applyReschedule(state, payload) {
  const { requestId, baseVersion, risk } = payload;
  const check = requireCurrentVersion(state, requestId, baseVersion);
  if (check.error) return check.error;
  const { request, record } = check;
  if (TERMINAL_STATES.has(record.state)) return reject('not-reschedulable', { state: record.state });
  const nextRisk = risk === undefined ? record.risk : risk;
  if (!isRisk(nextRisk)) return reject('invalid-risk');
  const released = HOLDING_STATES.has(record.state) ? 1 : 0;
  record.state = 'rescheduled'; // 旧版本进入终态，永不回到候补队列
  const nextVersion = request.currentVersion + 1;
  request.versions[nextVersion] = {
    version: nextVersion,
    risk: nextRisk,
    queuedAt: record.queuedAt, // 改期保留最初排队时间
    state: 'submitted',
  };
  request.currentVersion = nextVersion;
  const outcome = accept({ requestId, version: nextVersion, releases: released });
  settle(state, outcome); // 若旧版本占着窗口，释放出的空位按规则递补
  outcome.state = request.versions[nextVersion].state;
  return outcome;
}

function applyLock(state, payload) {
  const check = requireCurrentVersion(state, payload.requestId, payload.version);
  if (check.error) return check.error;
  const { record } = check;
  if (record.state === 'approved') return reject('already-approved');
  if (record.state !== 'window-held') return reject('not-held', { state: record.state });
  record.state = 'approved';
  return accept({ requestId: payload.requestId, version: payload.version, state: 'approved' });
}

function applyCancel(state, payload) {
  const check = requireCurrentVersion(state, payload?.requestId, payload?.version);
  if (check.error) return check.error;
  const { record } = check;
  if (record.state === 'cancelled') return reject('already-cancelled');
  if (record.state === 'completed') return reject('already-completed');
  const released = HOLDING_STATES.has(record.state) ? 1 : 0;
  record.state = 'cancelled';
  const outcome = accept({
    requestId: payload.requestId,
    version: payload.version,
    state: 'cancelled',
    releases: released,
  });
  if (released) settle(state, outcome); // 只有真正占窗的版本取消才释放容量
  return outcome;
}

function applyComplete(state, payload) {
  const check = requireCurrentVersion(state, payload.requestId, payload.version);
  if (check.error) return check.error;
  const { record } = check;
  if (record.state === 'completed') return reject('already-completed');
  if (record.state === 'cancelled') return reject('already-cancelled');
  if (!HOLDING_STATES.has(record.state)) return reject('not-held', { state: record.state });
  record.state = 'completed';
  const outcome = accept({
    requestId: payload.requestId,
    version: payload.version,
    state: 'completed',
    releases: 1,
  });
  settle(state, outcome);
  return outcome;
}

// 批量取消：逐项按顺序处理，每项独立校验版本；每一项释放都各自触发一次递补，
// 结果里汇总获得窗口的班组与被跳过申请的具体理由。
function applyBatchCancel(state, payload) {
  const { items } = payload;
  if (!Array.isArray(items) || items.length === 0) return reject('invalid-items');
  const itemOutcomes = [];
  const promotions = [];
  const skipped = [];
  const seenSkips = new Set();
  let applied = 0;
  for (const item of items) {
    const itemOutcome = applyCancel(state, item ?? {});
    applied += itemOutcome.accepted ? 1 : 0;
    itemOutcomes.push({
      requestId: item?.requestId ?? null,
      version: item?.version ?? null,
      accepted: itemOutcome.accepted,
      ...(itemOutcome.reason ? { reason: itemOutcome.reason } : {}),
      ...(itemOutcome.currentVersion ? { currentVersion: itemOutcome.currentVersion } : {}),
    });
    promotions.push(...itemOutcome.promotions);
    for (const skip of itemOutcome.skipped) {
      const key = skipKey(skip);
      if (!seenSkips.has(key)) {
        seenSkips.add(key);
        skipped.push(skip);
      }
    }
  }
  if (applied === 0) return reject('no-items-applied', { items: itemOutcomes });
  return accept({ items: itemOutcomes, promotions, skipped });
}

export function applyEvent(state, event) {
  const type = event?.type;
  const payload = event?.payload ?? {};
  let outcome;
  switch (type) {
    case 'capacity-set': outcome = applyCapacitySet(state, payload); break;
    case 'request-submitted': outcome = applySubmit(state, payload); break;
    case 'request-rescheduled': outcome = applyReschedule(state, payload); break;
    case 'request-locked': outcome = applyLock(state, payload); break;
    case 'request-cancelled': outcome = applyCancel(state, payload); break;
    case 'request-completed': outcome = applyComplete(state, payload); break;
    case 'batch-cancelled': outcome = applyBatchCancel(state, payload); break;
    default: outcome = reject('unknown-event-type');
  }
  outcome.occupancy = countHolders(state);
  outcome.capacity = state.capacity;
  return outcome;
}
