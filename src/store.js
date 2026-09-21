// JSONL 事件存储：只追加写入，启动时按顺序重放重建状态。
// 同一事件行含 eventId，配合 foldEvent 的去重，重复/乱序行不会二次生效。

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async ensure() {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  /** 读取全部事件；损坏行会被跳过而不是让整个服务无法启动。 */
  async readAll() {
    await this.ensure();
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const events = [];
    for (const [index, line] of raw.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // 记录行号但继续重放，保证其余历史可用
        events.push({ __corrupt: true, line: index + 1 });
      }
    }
    return events;
  }

  /** 一批事件在单次追加中落盘，避免“改期上半段已落盘”的半截命令。 */
  async append(events) {
    if (!events.length) return;
    const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    await appendFile(this.filePath, payload);
  }
}
