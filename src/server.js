import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { countHolders, holders, isRisk, rankWaitlist } from './domain.js';
import { EventStore } from './store.js';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const text = await readBody(request);
  if (!text) return {};
  return JSON.parse(text);
}

function snapshot(store) {
  const { state } = store;
  return {
    capacity: state.capacity,
    occupancy: countHolders(state),
    holders: holders(state),
    waitlist: rankWaitlist(state).map((candidate, index) => ({ position: index + 1, ...candidate })),
    requests: state.requests,
    events: store.records.length,
  };
}

function statusFor(outcome) {
  if (outcome.accepted) return 200;
  return outcome.reason === 'unknown-request' ? 404 : 409;
}

function handleCommand(store, segments, body, response) {
  const eventId = typeof body.eventId === 'string' && body.eventId ? body.eventId : null;

  // 提交申请（版本 1 进入候补；有空位时自动递补）
  if (segments[0] === 'requests' && segments.length === 1) {
    const { requestId, turbine, crew, risk } = body;
    if (typeof requestId !== 'string' || !requestId) return sendJson(response, 400, { error: 'invalid-request-id' });
    if (typeof turbine !== 'string' || !turbine) return sendJson(response, 400, { error: 'invalid-turbine' });
    if (typeof crew !== 'string' || !crew) return sendJson(response, 400, { error: 'invalid-crew' });
    if (!isRisk(risk)) return sendJson(response, 400, { error: 'invalid-risk' });
    const queuedAt = body.queuedAt ?? new Date().toISOString();
    if (typeof queuedAt !== 'string' || Number.isNaN(Date.parse(queuedAt))) {
      return sendJson(response, 400, { error: 'invalid-queued-at' });
    }
    const outcome = store.apply('request-submitted', { requestId, turbine, crew, risk, queuedAt }, eventId);
    return sendJson(response, statusFor(outcome), outcome);
  }

  // 针对单个申请的版本化命令
  if (segments[0] === 'requests' && segments.length === 3) {
    const requestId = segments[1];
    const action = segments[2];
    if (action === 'reschedule') {
      const { baseVersion, risk } = body;
      if (!Number.isInteger(baseVersion)) return sendJson(response, 400, { error: 'invalid-base-version' });
      if (risk !== undefined && !isRisk(risk)) return sendJson(response, 400, { error: 'invalid-risk' });
      const payload = { requestId, baseVersion, ...(risk !== undefined ? { risk } : {}) };
      const outcome = store.apply('request-rescheduled', payload, eventId);
      return sendJson(response, statusFor(outcome), outcome);
    }
    const types = { lock: 'request-locked', cancel: 'request-cancelled', complete: 'request-completed' };
    if (types[action]) {
      const { version } = body;
      if (!Number.isInteger(version)) return sendJson(response, 400, { error: 'invalid-version' });
      const outcome = store.apply(types[action], { requestId, version }, eventId);
      return sendJson(response, statusFor(outcome), outcome);
    }
    return sendJson(response, 404, { error: 'not-found' });
  }

  // 批量取消：响应里直接带获得窗口的班组与被跳过申请的具体理由
  if (segments[0] === 'cancellations' && segments.length === 1) {
    const { items } = body;
    if (!Array.isArray(items) || items.length === 0) return sendJson(response, 400, { error: 'invalid-items' });
    const outcome = store.apply('batch-cancelled', { items }, eventId);
    return sendJson(response, statusFor(outcome), outcome);
  }

  if (segments[0] === 'capacity' && segments.length === 1) {
    const { capacity } = body;
    if (!Number.isInteger(capacity) || capacity < 0) return sendJson(response, 400, { error: 'invalid-capacity' });
    const outcome = store.apply('capacity-set', { capacity }, eventId);
    return sendJson(response, statusFor(outcome), outcome);
  }

  return sendJson(response, 404, { error: 'not-found' });
}

export function buildServer(store) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

      if (request.method === 'GET' && segments.length === 0) {
        return sendJson(response, 200, {
          service: 'wind-maintenance',
          status: 'running',
          capacity: store.state.capacity,
          occupancy: countHolders(store.state),
        });
      }
      if (request.method === 'GET' && segments[0] === 'health' && segments.length === 1) {
        return sendJson(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && segments[0] === 'state' && segments.length === 1) {
        return sendJson(response, 200, snapshot(store));
      }
      if (request.method === 'GET' && segments[0] === 'events' && segments.length === 1) {
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
        return sendJson(response, 200, { events: store.records.slice(-limit) });
      }
      if (request.method === 'GET' && segments[0] === 'requests' && segments.length === 2) {
        const found = store.state.requests[segments[1]];
        if (!found) return sendJson(response, 404, { error: 'unknown-request' });
        return sendJson(response, 200, found);
      }
      if (request.method === 'POST' && segments[0] === 'debug' && segments[1] === 'replay' && segments.length === 2) {
        return sendJson(response, 200, store.verify());
      }
      if (request.method === 'POST') {
        let body;
        try {
          body = await readJson(request);
        } catch {
          return sendJson(response, 400, { error: 'invalid-json' });
        }
        return handleCommand(store, segments, body, response);
      }
      return sendJson(response, 404, { error: 'not-found' });
    } catch {
      return sendJson(response, 500, { error: 'internal-error' });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const store = new EventStore(process.env.DATA_DIR || 'data', {
    capacity: Number(process.env.WINDOW_CAPACITY) || 1,
  });
  const server = buildServer(store);
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => {
    console.log(`wind-maintenance listening on :${port} (data: ${store.file})`);
  });
}
