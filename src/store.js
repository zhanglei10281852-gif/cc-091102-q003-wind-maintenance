// 事件存储：接受的命令先追加到 data/events.jsonl 并 fsync，再算成功；
// 重启时按日志顺序重放同一规约器，恢复出完全一致的占用数与递补顺序。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { applyEvent, countHolders, createState } from './domain.js';

export function replayRecords(records, capacity = 1) {
  const state = createState(capacity);
  for (const record of records) {
    applyEvent(state, { type: record.type, payload: record.payload });
  }
  return state;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class EventStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'events.jsonl');
    this.defaultCapacity = options.capacity ?? 1;
    mkdirSync(dir, { recursive: true });
    this.records = [];
    this.outcomesByEventId = new Map();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          break; // 崩溃可能留下半行，忽略其后的内容
        }
        this.records.push(record);
        if (record.eventId) this.outcomesByEventId.set(record.eventId, record.outcome);
      }
    }
    this.state = replayRecords(this.records, this.defaultCapacity);
    this.fd = openSync(this.file, 'a');
  }

  // eventId 是客户端幂等键：重复投递时返回首次结果，不重复应用。
  // 被拒绝的命令不落盘 —— 规约器是纯函数，重试会得到同样的拒绝。
  apply(type, payload, eventId = null) {
    if (eventId && this.outcomesByEventId.has(eventId)) {
      return { ...this.outcomesByEventId.get(eventId), duplicate: true };
    }
    const outcome = applyEvent(this.state, { type, payload });
    if (!outcome.accepted) return outcome;
    const record = {
      seq: this.records.length + 1,
      eventId,
      type,
      payload,
      outcome,
      recordedAt: new Date().toISOString(),
    };
    writeSync(this.fd, `${JSON.stringify(record)}\n`);
    fsyncSync(this.fd);
    this.records.push(record);
    if (eventId) this.outcomesByEventId.set(eventId, outcome);
    return outcome;
  }

  // 用日志从头重建状态并与当前内存状态比对，验证重放确定性。
  verify() {
    const replayed = replayRecords(this.records, this.defaultCapacity);
    return {
      ok: stableStringify(replayed) === stableStringify(this.state),
      events: this.records.length,
      capacity: this.state.capacity,
      occupancy: countHolders(this.state),
      replayedOccupancy: countHolders(replayed),
    };
  }

  close() {
    closeSync(this.fd);
  }
}
