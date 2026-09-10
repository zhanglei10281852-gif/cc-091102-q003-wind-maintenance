export const requestStates = ['submitted', 'window-held', 'approved', 'rescheduled', 'cancelled'];
export const riskOrder = { critical: 3, high: 2, routine: 1 };

export function cancelAndPromote(state, event) {
  const request = state.requests.find(item => item.requestId === event.requestId);
  request.state = 'cancelled';
  state.capacity += 1;
  const next = state.requests.filter(item => item.state !== 'approved')
    .sort((a, b) => riskOrder[b.risk] - riskOrder[a.risk] || a.queuedAt.localeCompare(b.queuedAt))[0];
  if (next) { next.state = 'approved'; state.capacity -= 1; }
  return next;
}
