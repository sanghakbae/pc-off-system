'use strict';

const isStaticHost = !['localhost', '127.0.0.1'].includes(window.location.hostname);
const baseNow = Date.now();
const machines = [
  { id: 1, hostname: 'PC-DEMO-001', username: '홍길동', os: 'macOS', online: false, state: 'offline', source: 'agent', ip: '172.30.1.29', local_ip: '172.30.1.29', mac: '8c:85:90:11:23:01', vpn_connected: false, security_tools: { v3: { installed: true, running: true }, officekeeper: { installed: true, running: true } }, first_seen: baseNow - 86400000 * 12, last_seen: baseNow - 3600000 * 5, status_updated_at: baseNow - 3600000 * 5, last_event_type: 'lock', last_event_at: baseNow - 3600000 * 5 },
  { id: 2, hostname: 'PC-DEMO-002', username: '김철수', os: 'macOS', online: true, state: 'unlocked', source: 'agent', ip: '192.168.48.17', local_ip: '192.168.48.17', mac: '8c:85:90:11:23:02', vpn_connected: false, security_tools: { v3: { installed: true, running: true }, officekeeper: { installed: true, running: true } }, first_seen: baseNow - 86400000 * 10, last_seen: baseNow - 60000, status_updated_at: baseNow - 60000, last_event_type: 'unlock', last_event_at: baseNow - 60000 },
  { id: 3, hostname: 'PC-DEMO-003', username: '이영희', os: 'Windows', online: true, state: 'unlocked', source: 'agent', ip: '192.168.48.13', local_ip: '192.168.48.13', mac: '8c:85:90:11:23:03', vpn_connected: true, vpn_ip: '10.8.0.13', security_tools: { v3: { installed: true, running: true }, officekeeper: { installed: true, running: true } }, first_seen: baseNow - 86400000 * 8, last_seen: baseNow - 120000, status_updated_at: baseNow - 120000, last_event_type: 'unlock', last_event_at: baseNow - 120000 },
  { id: 4, hostname: 'PC-DEMO-004', username: '박민수', os: 'Windows', online: false, state: 'offline', source: 'ping', ip: '192.168.48.190', local_ip: '192.168.48.190', mac: '50:58:56:66:a8:a2', vpn_connected: false, security_tools: { v3: { installed: false, running: false }, officekeeper: { installed: false, running: false } }, first_seen: baseNow - 86400000 * 7, last_seen: baseNow - 86400000 * 5, status_updated_at: baseNow - 86400000 * 5 },
  { id: 5, hostname: 'PC-DEMO-005', username: '정수진', os: 'macOS', online: true, state: 'locked', source: 'agent', ip: '192.168.48.244', local_ip: '192.168.48.244', mac: '8c:85:90:11:23:05', vpn_connected: false, security_tools: { v3: { installed: true, running: false }, officekeeper: { installed: true, running: true } }, first_seen: baseNow - 86400000 * 5, last_seen: baseNow - 300000, status_updated_at: baseNow - 300000, last_event_type: 'lock', last_event_at: baseNow - 300000 },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function dateStr(offset = 0) {
  const d = new Date(baseNow + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}
function eventRows(date = dateStr()) {
  return machines.flatMap((m, index) => [
    { ts: baseNow - (index + 2) * 3600000, received_at: baseNow - (index + 2) * 3600000 + 3000, type: 'unlock', hostname: m.hostname, username: m.username, source: m.source, ip: m.ip, local_ip: m.local_ip, mac: m.mac, vpn_connected: m.vpn_connected, vpn_ip: m.vpn_ip, event_status: 'online', date },
    { ts: baseNow - (index + 1) * 1800000, received_at: baseNow - (index + 1) * 1800000 + 3000, type: index % 2 ? 'lock' : 'login', hostname: m.hostname, username: m.username, source: m.source, ip: m.ip, local_ip: m.local_ip, mac: m.mac, vpn_connected: m.vpn_connected, vpn_ip: m.vpn_ip, event_status: index % 2 ? 'locked' : 'online', date },
  ]);
}
function awayRows(date = dateStr()) {
  return machines.map((m, i) => ({
    ...m,
    date,
    arrival: baseNow - (8 - i) * 3600000,
    departure: i === 1 ? null : baseNow - (1 + i) * 1800000,
    departureEstimated: i !== 1,
    awayCount: [3, 2, 4, 1, 5][i],
    totalAwaySec: [3000, 7200, 5400, 900, 18840][i],
    longestAwaySec: [1500, 3600, 4200, 900, 10320][i],
    lateArrival: i === 0 || i === 2,
    longAway: i === 4,
    frequent: i === 2 || i === 4,
  }));
}
function report(from = dateStr(-6), to = dateStr()) {
  const days = Array.from({ length: 5 }, (_, i) => dateStr(i - 5));
  const rows = machines.map((m, i) => ({
    ...m,
    basis: m.source === 'ping' ? 'power' : 'agent',
    totals: { presentSec: 18000 * (i + 1), avgPresentSec: 7200 + i * 900, lateDays: i % 3, lateRate: i ? 25 : 100, awayCount: 4 + i },
    days: days.slice(0, i + 1).map((day, idx) => ({
      date: day,
      arrival: baseNow - (8 - idx) * 3600000,
      departure: idx % 2 ? null : baseNow - (2 + idx) * 1800000,
      departureEstimated: idx % 2 === 0,
      presentSec: 12000 + idx * 1400,
      awayCount: idx + 1,
      totalAwaySec: idx * 1200,
      lateArrival: idx % 2 === 0,
    })),
  }));
  return { ok: true, from, to, days: 7, summary: { machineCount: machines.length, recordDays: 20, totalPresentSec: 213540, avgPresentSec: 10680, lateDays: 10 }, machines: rows };
}
function stats() {
  return {
    ok: true,
    kpi: { total: 5, online: 3, locked: 1, offline: 2, vpn: 1, blind: 1 },
    status: { offline: 2, online: 2, locked: 1 },
    os: { Windows: 2, macOS: 3 },
    vpn: { connected: 1, disconnected: 4 },
    security: { reported: 3, v3Installed: 3, v3Running: 2, okInstalled: 3, okRunning: 3 },
    weekday: [1, 2, 3, 4, 5].map((dow, i) => ({ dow, n: [12, 18, 22, 16, 9][i] })),
    topUsers: machines.map((m, i) => ({ k: m.username, n: [51, 48, 38, 12, 6][i] })),
  };
}

if (isStaticHost) {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    if (url.pathname === '/api/machines') return json({ now: Date.now(), machines });
    if (url.pathname === '/api/stats') return json(stats());
    if (url.pathname === '/api/away') return json({ ok: true, date: url.searchParams.get('date') || dateStr(), machines: awayRows(url.searchParams.get('date') || dateStr()) });
    if (url.pathname === '/api/logs') return json({ ok: true, events: eventRows(url.searchParams.get('date') || dateStr()) });
    if (url.pathname === '/api/report') return json(report(url.searchParams.get('from') || dateStr(-6), url.searchParams.get('to') || dateStr()));
    if (url.pathname === '/api/anomalies') return json({ ok: true, anomalies: [{ ts: baseNow - 3600000, hostname: 'PC-DEMO-003', type: 'short_work', reasons: ['단시간근무'], presentSec: 10620 }] });
    if (url.pathname === '/api/coverage') return json({ ok: true, total: 5, blindCount: 1, blind: [{ ...machines[3], kind: '보고 끊김', ageSec: 432000 }] });
    if (url.pathname === '/api/events/search') return json({ ok: true, count: eventRows().length, events: eventRows() });
    if (url.pathname === '/api/device-directory') return json({ ok: true, rows: machines.map((m) => ({ id: m.id, username: m.username, mac: m.mac, ip: m.local_ip })) });
    const eventMatch = url.pathname.match(/^\/api\/machines\/(\d+)\/events$/);
    if (eventMatch) return json({ ok: true, events: eventRows().filter((e) => String(machines.find((m) => m.hostname === e.hostname)?.id) === eventMatch[1]) });
    const ipMatch = url.pathname.match(/^\/api\/machines\/(\d+)\/ip-history$/);
    if (ipMatch) return json({ ok: true, rows: [{ changed_at: baseNow - 86400000, remote_ip: '211.234.10.10', local_ip: machines[Number(ipMatch[1]) - 1]?.local_ip, vpn_connected: false, mac: machines[Number(ipMatch[1]) - 1]?.mac, reason: 'initial' }] });
    return json({ ok: true });
  };
}
