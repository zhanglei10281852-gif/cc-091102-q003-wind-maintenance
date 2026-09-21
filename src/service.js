// 应用服务：校验命令 -> 在工作副本上产生事件 -> 递补 -> 一次追加落盘 -> 切换内存状态。
// 命令串行提交；事件全部先写盘后生效，重启重放即可得到相同占用数与递补顺序。

import { EventStore } from './store.js';
import {
  createState,
  cloneState,
  foldEvent,
  pumpAll,
  getRequest,
  snapshot,
  requestView,
  riskOrder,
  HOLD_STATES,
} from './domain.js';

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ISO = () => new Date().toISOString();

export class SchedulingService {
  constructor(store, { now = ISO } = {}) {
    this.store = store;
    this.now = now;
    this.state = createState();
    this._chain = Promise.resolve();
  }

  /** 从事件日志重建状态（服务重启入口）。 */
  async load() {
    const state = createState();
    const lines = await this.store.readAll();
    for (const event of lines) {
      if (!event.__corrupt) foldEvent(state, event);
    }
    this.state = state;
    return state;
  }

  // 串行执行所有写命令，避免并发命令互相覆盖
  _enqueue(fn) {
    const run = this._chain.then(() => this._run(fn));
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async _run(fn) {
    const working = cloneState(this.state);
    const timestamp = this.now();
    const { events = [], result = {} } = fn(working, timestamp);
    // 同一次命令的事件共享时间戳；补齐各事件构造时留空的 timestamp
    for (const event of events) {
      if (event.timestamp === undefined) event.timestamp = timestamp;
      foldEvent(working, event);
    }
    // 命令事件 + 递补事件在同一次追加中落盘：不会出现“释放已落盘、递补丢失”
    const promotion = pumpAll(working, timestamp);
    await this.store.append([...events, ...promotion.events]);
    this.state = working;
    // 响应反映递补后的真实状态（提交可能已自动锁定窗口）
    if (result.request && result.request.requestId !== undefined) {
      const version = result.request.version ?? working.latest.get(result.request.requestId);
      const rec = working.records.get(`${result.request.requestId}#${version}`);
      if (rec) result.request = requestView(rec);
    }
    return { ...result, promotion };
  }

  // ---- 基础资料 ----

  registerTurbine(body) {
    return this._enqueue(() => {
      const turbineId = requireId(body, 'turbineId');
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new ApiError(400, 'invalid-capacity', 'capacity 必须为正整数');
      }
      if (this.state.turbines.has(turbineId)) {
        throw new ApiError(409, 'turbine-exists', '风机已登记', { turbineId });
      }
      const event = { eventId: `turbine:${turbineId}`, type: 'turbine-registered', timestamp: undefined, turbineId, capacity };
      return { events: [event], result: { turbine: { turbineId, capacity } } };
    });
  }

  registerCrew(body) {
    return this._enqueue(() => {
      const crewId = requireId(body, 'crewId');
      if (this.state.crews.has(crewId)) {
        throw new ApiError(409, 'crew-exists', '班组已登记', { crewId });
      }
      const event = { eventId: `crew:${crewId}`, type: 'crew-registered', timestamp: undefined, crewId };
      return { events: [event], result: { crew: { crewId } } };
    });
  }

  // ---- 申请命令 ----

  submit(body) {
    return this._enqueue(() => {
      const requestId = requireId(body, 'requestId');
      const version = body.version === undefined ? 1 : Number(body.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(400, 'invalid-version', 'version 必须为不小于 1 的整数');
      }
      const existing = getRequest(this.state, requestId);
      if (!existing && version !== 1) {
        throw new ApiError(400, 'invalid-version', '首次提交 version 必须为 1');
      }
      if (existing) {
        if (existing.currentVersion + 1 !== version) {
          throw new ApiError(409, 'version-conflict', '新版本号必须接续当前版本', {
            currentVersion: existing.currentVersion,
          });
        }
        if (['cancelled', 'completed'].includes(existing.current.state)) {
          throw new ApiError(409, 'request-terminal', '已取消或已完成的申请不能继续改期，请重新发起申请');
        }
      }
      // 改期/新版本一律保留该申请的最初排队时间，风险相同时排序不变
      const queuedAt = existing ? existing.versions[0].queuedAt : body.queuedAt;
      this.validateSubmission(this.state, { ...body, queuedAt });
      const submitEvent = {
        eventId: `submit:${requestId}:v${version}`,
        type: 'request-submitted',
        timestamp: undefined,
        requestId,
        version,
        turbine: body.turbine,
        crew: body.crew,
        risk: body.risk,
        queuedAt,
        ...(existing ? { basedOn: existing.currentVersion } : {}),
      };
      const events = existing
        ? [{
            eventId: `supersede:${requestId}:v${existing.currentVersion}`,
            type: 'request-superseded',
            timestamp: undefined,
            requestId,
            version: existing.currentVersion,
          }, submitEvent]
        : [submitEvent];
      return {
        events,
        result: { request: { requestId, version, turbine: body.turbine, crew: body.crew, risk: body.risk, queuedAt, state: 'submitted' } },
      };
    });
  }

  reschedule(requestId, body) {
    return this._enqueue(() => {
      const current = this.requireCurrent(requestId);
      if (['cancelled', 'completed'].includes(current.current.state)) {
        throw new ApiError(409, 'request-terminal', '已取消或已完成的申请不能改期');
      }
      const turbine = body.turbine ?? current.current.turbine;
      const crew = body.crew ?? current.current.crew;
      const risk = body.risk ?? current.current.risk;
      this.validateSubmission(this.state, { turbine, crew, risk, queuedAt: current.current.queuedAt });
      // 改期跨版本保留“最初排队时间”：风险相同时排队先后不变
      const queuedAt = current.versions[0].queuedAt;
      const oldVersion = current.currentVersion;
      const version = oldVersion + 1;
      const events = [
        {
          eventId: `supersede:${requestId}:v${oldVersion}`,
          type: 'request-superseded',
          timestamp: undefined,
          requestId,
          version: oldVersion,
        },
        {
          eventId: `submit:${requestId}:v${version}`,
          type: 'request-submitted',
          timestamp: undefined,
          requestId,
          version,
          turbine,
          crew,
          risk,
          queuedAt,
          basedOn: oldVersion,
        },
      ];
      return {
        events,
        result: {
          request: { requestId, version, turbine, crew, risk, queuedAt, state: 'submitted' },
          superseded: oldVersion,
        },
      };
    });
  }

  approve(requestId) {
    return this._enqueue(() => {
      const current = this.requireCurrent(requestId);
      if (current.current.state !== 'window-held') {
        throw new ApiError(409, 'invalid-state', '只有已锁定窗口(window-held)的申请可以审批', {
          state: current.current.state,
        });
      }
      const version = current.currentVersion;
      const event = { eventId: `approve:${requestId}:v${version}`, type: 'window-approved', timestamp: undefined, requestId, version };
      return { events: [event], result: { request: { ...current.current, state: 'approved' } } };
    });
  }

  complete(requestId) {
    return this._enqueue(() => {
      const current = this.requireCurrent(requestId);
      if (!HOLD_STATES.has(current.current.state)) {
        throw new ApiError(409, 'invalid-state', '只有持有窗口的申请可以完成', {
          state: current.current.state,
        });
      }
      const version = current.currentVersion;
      const event = { eventId: `complete:${requestId}:v${version}`, type: 'window-completed', timestamp: undefined, requestId, version };
      return { events: [event], result: { request: { ...current.current, state: 'completed' } } };
    });
  }

  cancel(requestId) {
    return this._enqueue(() => {
      const current = this.requireCurrent(requestId);
      if (!['submitted', 'window-held', 'approved'].includes(current.current.state)) {
        throw new ApiError(409, 'invalid-state', '当前状态不能取消', { state: current.current.state });
      }
      const version = current.currentVersion;
      const event = { eventId: `cancel:${requestId}:v${version}`, type: 'request-cancelled', timestamp: undefined, requestId, version };
      return { events: [event], result: { cancelled: { requestId, version } } };
    });
  }

  /** 批量取消：一次性落盘并统一递补，返回每个获得窗口的班组和每条跳过理由。 */
  cancelBatch(body) {
    return this._enqueue(() => {
      if (!body || !Array.isArray(body.requestIds) || body.requestIds.length === 0) {
        throw new ApiError(400, 'invalid-payload', 'requestIds 必须为非空数组');
      }
      const cancelled = [];
      const errors = [];
      const events = [];
      for (const raw of body.requestIds) {
        const requestId = String(raw);
        try {
          const current = this.requireCurrent(requestId);
          if (!['submitted', 'window-held', 'approved'].includes(current.current.state)) {
            throw new ApiError(409, 'invalid-state', '当前状态不能取消', { state: current.current.state });
          }
          const version = current.currentVersion;
          events.push({ eventId: `cancel:${requestId}:v${version}`, type: 'request-cancelled', timestamp: undefined, requestId, version });
          cancelled.push({ requestId, version });
        } catch (error) {
          errors.push({ requestId, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
        }
      }
      return { result: { cancelled, errors }, events };
    });
  }

  // ---- 查询 ----

  getRequest(requestId) {
    return this.requireCurrent(requestId);
  }

  getTurbine(turbineId) {
    const view = snapshot(this.state).turbines.find((item) => item.turbineId === turbineId);
    if (!view) throw new ApiError(404, 'not-found', '风机不存在', { turbineId });
    return view;
  }

  getState() {
    return snapshot(this.state);
  }

  async getEvents() {
    return (await this.store.readAll()).filter((event) => !event.__corrupt);
  }

  // ---- 校验辅助 ----

  requireCurrent(requestId) {
    const current = getRequest(this.state, requestId);
    if (!current) throw new ApiError(404, 'not-found', '申请不存在', { requestId });
    return current;
  }

  validateSubmission(state, body) {
    if (!body || typeof body.turbine !== 'string' || typeof body.crew !== 'string') {
      throw new ApiError(400, 'invalid-payload', 'turbine 与 crew 为必填字符串');
    }
    if (!state.turbines.has(body.turbine)) {
      throw new ApiError(422, 'unknown-turbine', '风机未登记', { turbine: body.turbine });
    }
    if (!state.crews.has(body.crew)) {
      throw new ApiError(422, 'unknown-crew', '班组未登记', { crew: body.crew });
    }
    if (!(body.risk in riskOrder)) {
      throw new ApiError(400, 'invalid-risk', `risk 必须为 ${Object.keys(riskOrder).join('/')}`, { risk: body.risk });
    }
    if (!body.queuedAt || Number.isNaN(Date.parse(body.queuedAt))) {
      throw new ApiError(400, 'invalid-queued-at', 'queuedAt 必须为可解析时间');
    }
  }
}

function requireId(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'invalid-payload', `${field} 为必填字符串`);
  }
  return value;
}

export function createService(dataPath, options) {
  return new SchedulingService(new EventStore(dataPath), options);
}
