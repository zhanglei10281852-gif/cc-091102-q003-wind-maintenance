// HTTP API：围绕风机、作业班组与有版本申请的提交/锁定/改期/取消/完成。
// 所有写操作经 SchedulingService 串行化并以事件落盘，重启后重放恢复。

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createService, ApiError } from './service.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.EVENT_LOG || join(here, '..', 'data', 'events.jsonl');
const service = createService(dataFile);

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new ApiError(413, 'payload-too-large', '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid-json', '请求体不是合法 JSON');
  }
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

// method + 路径模式 -> 处理器
const routes = [
  ['GET', /^\/health$/, () => ({ service: 'wind-maintenance', status: 'running' })],

  ['POST', /^\/turbines$/, (_m, body) => service.registerTurbine(body)],
  ['POST', /^\/crews$/, (_m, body) => service.registerCrew(body)],
  ['GET', /^\/turbines$/, () => service.getState()],
  ['GET', /^\/turbines\/([^/]+)$/, (m) => service.getTurbine(decodeURIComponent(m[1]))],

  ['POST', /^\/requests$/, (_m, body) => service.submit(body)],
  ['GET', /^\/requests$/, () => service.getState()],
  ['GET', /^\/requests\/([^/]+)$/, (m) => service.getRequest(decodeURIComponent(m[1]))],
  ['POST', /^\/requests\/([^/]+)\/reschedule$/, (m, body) => service.reschedule(decodeURIComponent(m[1]), body)],
  ['POST', /^\/requests\/([^/]+)\/approve$/, (m) => service.approve(decodeURIComponent(m[1]))],
  ['POST', /^\/requests\/([^/]+)\/complete$/, (m) => service.complete(decodeURIComponent(m[1]))],
  ['POST', /^\/requests\/([^/]+)\/cancel$/, (m) => service.cancel(decodeURIComponent(m[1]))],

  // 批量取消：立即返回获得窗口的班组与被跳过申请的具体理由
  ['POST', /^\/cancel-batch$/, (_m, body) => service.cancelBatch(body)],

  ['GET', /^\/events$/, async () => ({ events: await service.getEvents() })],
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (request.method === 'GET') {
      for (const [method, pattern, handler] of routes) {
        if (method !== 'GET') continue;
        const match = url.pathname.match(pattern);
        if (match) return send(response, 200, await handler(match, null));
      }
      return send(response, 404, { error: { code: 'not-found', message: '未知接口' } });
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      for (const [method, pattern, handler] of routes) {
        if (method !== 'POST') continue;
        const match = url.pathname.match(pattern);
        if (match) return send(response, 200, await handler(match, body));
      }
      return send(response, 404, { error: { code: 'not-found', message: '未知接口' } });
    }
    send(response, 405, { error: { code: 'method-not-allowed', message: '仅支持 GET/POST' } });
  } catch (error) {
    if (error instanceof ApiError) {
      return send(response, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    send(response, 500, { error: { code: 'internal-error', message: error.message || '内部错误' } });
  }
});

const port = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);

export async function start(listenPort = port) {
  await service.load();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, resolve);
  });
  return { port: server.address().port };
}

export { server, service };

// 直接运行时启动；被测试导入时不自动监听
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().then(({ port: p }) => {
    console.log(`wind-maintenance listening on ${p}, event log: ${dataFile}`);
  });
}
