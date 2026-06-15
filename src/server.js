'use strict';
const path = require('path');
const express = require('express');
const XLSX = require('@e965/xlsx');
const { ready, stmts, ingest, archivePingMachine, archiveOrphanPingMachines, getStats, closeStaleOfflineSessions, config } = require('./db');
const pinger = require('./pinger');
const { computeAway } = require('./away');
const firebase = require('./firebase');
const r2 = require('./r2');
const cloudflareDns = require('./cloudflareDns');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// 에이전트 파일 다운로드 (배포 사이트에서 받기)
app.use('/download', express.static(path.join(__dirname, '..', 'agent')));

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/report') return next();
  return firebase.requireFirebaseAuth(req, res, next);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

const VALID_TYPES = new Set(['power_on', 'login', 'lock', 'unlock', 'heartbeat', 'shutdown']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function dayRange(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const now = new Date(Date.now() + KST_OFFSET_MS);
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) : now.getUTCMonth() + 1;
  const date = match ? Number(match[3]) : now.getUTCDate();
  if (!year || !month || !date) return null;
  const start = Date.UTC(year, month - 1, date) - KST_OFFSET_MS;
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

// 토큰 검증 미들웨어 (에이전트 보고용)
function requireToken(req, res, next) {
  const token = req.get('X-Agent-Token') || req.body.token;
  if (token !== config.token) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
  next();
}

// 머신의 온라인/상태 계산
function statusOf(m, now) {
  // 핑 대상은 마지막 핑 결과(last_state)로 온라인 여부 판단
  if (m.source === 'ping') {
    const online = m.last_state === 'online';
    return { online, state: online ? 'online' : 'offline' };
  }
  const offlineAfter = config.heartbeatSec * 2.5 * 1000;
  const online = now - m.last_seen <= offlineAfter;
  let state = m.last_state;
  // 온라인인데 아직 잠금 이벤트를 못 본 에이전트(하트비트로만 등록됨)는 '사용 중'으로 간주
  if (online && (state === 'unknown' || !state)) state = 'unlocked';
  if (!online) state = 'offline';
  return { online, state };
}

function currentStatusOf(state) {
  if (state === 'locked') return 'locked';
  if (state === 'offline') return 'offline';
  return 'online';
}

function visibleUserEvents(events) {
  return (events || []).filter((event) => event.type !== 'heartbeat');
}

function isVpnAddress(value) {
  const match = /^192\.168\.52\.(\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return false;
  const octet = Number(match[1]);
  return octet >= 1 && octet <= 254;
}

function mirrorEventToFirestore(report, machineId) {
  if (!firebase.getFirestore()) return;
  firebase.addFirestore('pmon_events', {
    machineId,
    hostname: report.hostname,
    username: report.username || null,
    os: report.os || null,
    type: report.type,
    ts: report.ts || Date.now(),
    localIp: report.local_ip || null,
    remoteIp: report.ip || null,
    vpnConnected: Boolean(report.vpn_connected),
    vpnIp: report.vpn_ip || null,
    mac: report.mac || null,
  }).catch((error) => console.error('Firestore event mirror failed:', error.message));
  firebase.writeFirestore('pmon_machines', report.hostname, {
    machineId,
    hostname: report.hostname,
    username: report.username || null,
    os: report.os || null,
    lastType: report.type,
    lastSeen: Date.now(),
    localIp: report.local_ip || null,
    remoteIp: report.ip || null,
    mac: report.mac || null,
  }).catch((error) => console.error('Firestore machine mirror failed:', error.message));
}

function uploadCsvBackup(filename, csv) {
  if (!r2.configured()) return;
  r2.putObject(r2.backupKey(filename), Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8')
    .catch((error) => console.error('R2 backup failed:', error.message));
}

async function sendInstallNotification(machine) {
  const webhookUrl = String(config.installGoogleChatWebhookUrl || '').trim();
  if (!webhookUrl) return;
  const text = [
    '[PC OFF 에이전트 연결 완료]',
    `PC: ${machine.hostname || '-'}`,
    `사용자: ${machine.username || '-'}`,
    `OS: ${machine.os || '-'}`,
    `IP: ${machine.local_ip || machine.ip || '-'}`,
    `MAC: ${machine.mac || '-'}`,
    `연결시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}`,
  ].join('\n');
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error('install notification failed:', response.status, await response.text().catch(() => ''));
    }
  } catch (error) {
    console.error('install notification failed:', error.message);
  }
}

// 간단한 IPv4 / 호스트명 검증
function isValidHost(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (!s || s.length > 253) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = s.match(ipv4);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  // 호스트명도 허용 (영숫자, 점, 하이픈)
  return /^[a-zA-Z0-9.-]+$/.test(s);
}

// --- 에이전트 보고 수신 ---
app.post('/api/report', requireToken, async (req, res) => {
  const { hostname, type } = req.body;
  if (!hostname || typeof hostname !== 'string') {
    return res.status(400).json({ ok: false, error: 'hostname required' });
  }
  if (!VALID_TYPES.has(type)) {
    return res.status(400).json({ ok: false, error: 'invalid type' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].replace('::ffff:', '').trim();
  const rawBodyVpnIp = typeof req.body.vpn_ip === 'string' ? req.body.vpn_ip.trim() : '';
  // 에이전트가 보낸 vpn_ip 라도 실제 VPN 대역(192.168.52.x)일 때만 인정한다.
  // 구버전 에이전트가 LAN IP(예: 192.168.48.x)를 vpn_ip 로 잘못 보고하는 사례를 서버에서 방어.
  const bodyVpnIp = isVpnAddress(rawBodyVpnIp) ? rawBodyVpnIp : '';
  const remoteVpnIp = isVpnAddress(ip) ? ip : '';
  const vpnIp = bodyVpnIp || remoteVpnIp || null;
  const report = {
    hostname: hostname.trim(),
    username: req.body.username,
    os: req.body.os,
    ip,
    local_ip: typeof req.body.local_ip === 'string' ? req.body.local_ip.trim() : null,
    vpn_connected: Boolean(bodyVpnIp) || Boolean(remoteVpnIp),
    vpn_ip: vpnIp,
    mac: typeof req.body.mac === 'string' ? req.body.mac.trim().toLowerCase() : null,
    boot_time: Number(req.body.boot_time) || null,
    security_tools: req.body.security_tools && typeof req.body.security_tools === 'object' ? req.body.security_tools : null,
    type,
    ts: Number(req.body.ts) || Date.now(),
  };
  try {
    const ingestResult = await ingest(report);
    const id = typeof ingestResult === 'object' ? ingestResult.id : ingestResult;
    if (ingestResult && typeof ingestResult === 'object' && ingestResult.disabled) {
      return res.json({ ok: true, machine_id: id, disabled: true });
    }
    mirrorEventToFirestore(report, id);
    if (type === 'power_on') {
      const machine = await stmts.getMachine.get(id);
      if (machine && !machine.install_notified_at) {
        const now = Date.now();
        await stmts.markInstallNotified.run(id, now);
        sendInstallNotification({ ...machine, install_notified_at: now }).catch(() => {});
      }
    }
    res.json({ ok: true, machine_id: id });
  } catch (err) {
    console.error('ingest error:', err.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

app.post('/api/machines/:id/disable-monitoring', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid machine id' });
  const machine = await stmts.getMachine.get(id);
  if (!machine) return res.status(404).json({ ok: false, error: 'not found' });
  const result = await stmts.disableMachineMonitoring.run(id, Date.now());
  res.json({ ok: true, disabled: (result.rowCount || 0) > 0 });
});

// --- 머신 목록 + 현재 상태 ---
app.get('/api/machines', async (req, res) => {
  const now = Date.now();
  const machineRows = await stmts.listMachines.all();
  const machines = await Promise.all(machineRows.map(async (m) => {
    const { online, state } = statusOf(m, now);
    const currentStatus = currentStatusOf(state);
    if (m.current_status !== currentStatus) {
      await stmts.updateMachineCurrentStatus.run(m.id, currentStatus, now);
    }
    const lastSession = await stmts.lastSessionEvent.get(m.id);
    const latestEvent = await stmts.latestEvent.get(m.id);
    return {
      id: m.id,
      hostname: m.hostname,
      username: m.username,
      os: m.os,
      ip: m.ip,
      local_ip: m.local_ip,
      vpn_connected: m.vpn_connected === true,
      vpn_ip: m.vpn_ip,
      mac: m.mac,
      source: m.source || 'agent',
      boot_time: m.boot_time,
      work_start: m.work_start || '09:00',
      work_end: m.work_end || '18:00',
      security_tools: m.security_tools || null,
      first_seen: m.first_seen,
      last_seen: m.last_seen,
      online,
      state,
      current_status: currentStatus,
      status_updated_at: m.current_status === currentStatus ? m.status_updated_at : now,
      last_lock_change: lastSession ? lastSession.ts : null,
      last_event_type: latestEvent ? latestEvent.type : null,
      last_event_at: latestEvent ? latestEvent.ts : null,
    };
  }));
  res.json({ ok: true, now, machines });
});

app.post('/api/firebase/sync', async (_req, res) => {
  const db = firebase.getFirestore();
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured' });
  const now = Date.now();
  const machineRows = await stmts.listMachines.all();
  await Promise.all(machineRows.map((m) => firebase.writeFirestore('pmon_machines', m.hostname || m.id, {
    machineId: m.id,
    hostname: m.hostname,
    username: m.username || null,
    os: m.os || null,
    source: m.source || 'agent',
    currentStatus: m.current_status || 'offline',
    lastState: m.last_state || 'unknown',
    lastSeen: m.last_seen,
    localIp: m.local_ip || null,
    remoteIp: m.ip || null,
    vpnConnected: m.vpn_connected === true,
    vpnIp: m.vpn_ip || null,
    mac: m.mac || null,
    syncedAt: now,
  })));
  res.json({ ok: true, synced: machineRows.length });
});

app.get('/api/integrations/status', (_req, res) => {
  res.json({
    ok: true,
    firebaseAdmin: Boolean(firebase.getAdmin()),
    firebaseAuthRequired: firebase.authRequired(),
    firestore: Boolean(firebase.getFirestore()),
    r2: r2.configured(),
    cloudflareDns: cloudflareDns.configured(),
  });
});

app.get('/api/cloudflare/dns', async (_req, res) => {
  if (!cloudflareDns.configured()) return res.status(503).json({ ok: false, error: 'Cloudflare DNS is not configured' });
  try {
    const records = await cloudflareDns.listRecords();
    res.json({ ok: true, records: records.result || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/cloudflare/dns', async (req, res) => {
  if (!cloudflareDns.configured()) return res.status(503).json({ ok: false, error: 'Cloudflare DNS is not configured' });
  try {
    const record = await cloudflareDns.upsertRecord(req.body);
    res.json({ ok: true, record: record.result || record });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/machines/:id/username', async (req, res) => {
  const id = Number(req.params.id);
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid machine id' });
  if (username.length > 100) return res.status(400).json({ ok: false, error: '사용자 이름은 100자 이하로 입력하세요' });
  const machine = await stmts.getMachine.get(id);
  if (!machine) return res.status(404).json({ ok: false, error: 'not found' });
  await stmts.updateMachineUsername.run(id, username);
  res.json({ ok: true, id, username: username || null });
});

app.put('/api/machines/:id/profile', async (req, res) => {
  const id = Number(req.params.id);
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid machine id' });
  if (username.length > 100) return res.status(400).json({ ok: false, error: '사용자 이름은 100자 이하로 입력하세요' });
  const machine = await stmts.getMachine.get(id);
  if (!machine) return res.status(404).json({ ok: false, error: 'not found' });
  await stmts.updateMachineUsername.run(id, username);
  res.json({ ok: true, id, username: username || null });
});

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((v) => v.trim());
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return Object.fromEntries(header.map((key, index) => [key, cells[index] || '']));
  });
}

function parseWorkbookBase64(base64) {
  const workbook = XLSX.read(Buffer.from(String(base64 || ''), 'base64'), { type: 'buffer' });
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    rows.push(...XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false }));
  }
  return rows;
}

app.get('/api/device-directory/export.xlsx', async (_req, res) => {
  const rows = await stmts.listDeviceDirectory.all();
  const sheetRows = [
    ['사용자', 'mac', 'ip'],
    ...rows.map((row) => [
      row.username || '',
      row.mac || '',
      row.ip || row.connected_ip || '',
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hardware_asset.xlsx"');
  res.send(buffer);
});

app.get('/api/device-directory', async (_req, res) => {
  res.json({ ok: true, rows: await stmts.listDeviceDirectory.all() });
});

app.put('/api/device-directory/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
  const saved = await stmts.updateDeviceDirectoryRow.run(id, {
    username: req.body.username,
    mac: req.body.mac,
    ip: req.body.ip,
    connected_ip: req.body.connected_ip,
    hostname: req.body.hostname,
    system_type: req.body.system_type,
  });
  if (!saved.count) return res.status(404).json({ ok: false, error: 'not found' });
  const applied = await stmts.applyDeviceDirectoryToMachines.run();
  res.json({ ok: true, applied: applied.count });
});

app.post('/api/device-directory/import', async (req, res) => {
  const rows = Array.isArray(req.body?.rows)
    ? req.body.rows
    : req.body?.base64
      ? parseWorkbookBase64(req.body.base64)
    : parseCsv(req.body?.csv || req.body?.text || '');
  const imported = await stmts.replaceDeviceDirectoryRows.run(rows);
  const applied = await stmts.applyDeviceDirectoryToMachines.run();
  res.json({ ok: true, imported: imported.count, applied: applied.count });
});

// --- 통계 대시보드 집계 (기본: 최근 14일) ---
app.get('/api/stats', async (req, res) => {
  const today = new Date();
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : ymd(today);
  const from = typeof req.query.from === 'string' && req.query.from
    ? req.query.from
    : ymd(new Date(today.getTime() - 13 * 86400000));
  const range = rangeBounds(from, to);
  if (!range) return res.status(400).json({ ok: false, error: '날짜 범위 오류' });
  try {
    const stats = await getStats(range.start, range.end);
    res.json({ ok: true, from, to, ...stats });
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

// --- 특정 머신의 이벤트 타임라인 (기본: 오늘) ---
app.get('/api/machines/:id/events', async (req, res) => {
  const machine = await stmts.getMachine.get(Number(req.params.id));
  if (!machine) return res.status(404).json({ ok: false, error: 'not found' });

  // date=YYYY-MM-DD (한국 시간 자정 기준). 미지정 시 오늘.
  const range = dayRange(req.query.date);
  if (!range) return res.status(400).json({ ok: false, error: '날짜 형식 오류' });

  const events = visibleUserEvents(await stmts.eventsForMachine.all(machine.id, range.start, range.end));
  res.json({ ok: true, machine: { id: machine.id, hostname: machine.hostname }, ...range, events });
});

app.get('/api/machines/:id/ip-history', async (req, res) => {
  const machine = await stmts.getMachine.get(Number(req.params.id));
  if (!machine) return res.status(404).json({ ok: false, error: 'not found' });
  const from = typeof req.query.from === 'string' ? req.query.from : req.query.date;
  const to = typeof req.query.to === 'string' ? req.query.to : from;
  const range = from && to ? rangeBounds(from, to) : dayRange(req.query.date);
  if (!range) return res.status(400).json({ ok: false, error: '날짜 형식 오류' });
  const rows = await stmts.ipHistoryForMachine.all(machine.id, range.start, range.end);
  res.json({ ok: true, machine: { id: machine.id, hostname: machine.hostname }, ...range, rows });
});

// --- 핑 감시 대상 IP 관리 ---
app.get('/api/targets', async (req, res) => {
  res.json({ ok: true, targets: await stmts.listTargets.all() });
});

app.post('/api/targets', async (req, res) => {
  const ip = (req.body.ip || '').trim();
  const label = (req.body.label || '').trim() || null;
  if (!isValidHost(ip)) {
    return res.status(400).json({ ok: false, error: 'IP 또는 호스트명 형식이 올바르지 않습니다' });
  }
  try {
    const info = await stmts.insertTarget.run({ ip, label, now: Date.now() });
    pinger.sweep().catch(() => {}); // 추가 즉시 1회 핑
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: '이미 등록된 IP 입니다' });
    }
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

app.delete('/api/targets/:id', async (req, res) => {
  const t = await stmts.getTarget.get(Number(req.params.id));
  if (!t) return res.status(404).json({ ok: false, error: 'not found' });
  await stmts.deleteTarget.run(t.id);
  // 감시 대상에서만 제외하고, 그동안의 로그(events)는 DB에 보존 (일별 로그에서 계속 조회 가능)
  const archived = await archivePingMachine(t.ip);
  res.json({ ok: true, archived_machine: archived });
});

// --- 일별 로그 (특정 날짜의 전체 PC 이벤트) ---
const TYPE_KO = { power_on: '전원', login: '로그인', unlock: '잠금해제', lock: '잠금', shutdown: '종료' };

app.get('/api/logs', async (req, res) => {
  const range = dayRange(req.query.date);
  if (!range) return res.status(400).json({ ok: false, error: '날짜 형식 오류' });
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const events = visibleUserEvents(await stmts.eventsByDay.all(range.start, range.end, username));
  const meta = await stmts.eventDays.get();
  res.json({ ok: true, ...range, username: username || null, count: events.length, events, span: meta });
});

// CSV 내려받기
app.get('/api/logs.csv', async (req, res) => {
  const range = dayRange(req.query.date);
  if (!range) return res.status(400).send('날짜 형식 오류');
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const events = visibleUserEvents(await stmts.eventsByDay.all(range.start, range.end, username));
  const rows = [['시각', 'PC(호스트명)', '사용자', '상태', '접속 IP', '로컬 IP', 'VPN', 'VPN IP', 'MAC', '수신시각', '방식', '이벤트']];
  for (const e of events) {
    rows.push([
      new Date(e.ts).toLocaleString('ko-KR', { hour12: false }),
      e.hostname || '',
      e.username || '',
      e.event_status || e.current_status || e.last_state || '',
      e.ip || '',
      e.local_ip || '',
      e.vpn_connected ? 'Y' : '',
      e.vpn_ip || '',
      e.mac || '',
      e.received_at ? new Date(Number(e.received_at)).toLocaleString('ko-KR', { hour12: false }) : '',
      e.source === 'ping' ? '핑' : '에이전트',
      TYPE_KO[e.type] || e.type,
    ]);
  }
  const csv = '﻿' + rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const dateLabel = req.query.date || new Date().toISOString().slice(0, 10);
  const userLabel = username ? `-${username.replace(/[^\w.-]+/g, '_')}` : '';
  const filename = `pc-log-${dateLabel}${userLabel}.csv`;
  uploadCsvBackup(filename, csv);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// --- 자리 비움 분석 ---
app.get('/api/away', async (req, res) => {
  const data = await computeAway(req.query.date);
  if (!data) return res.status(400).json({ ok: false, error: '날짜 형식 오류' });
  res.json({ ok: true, ...data });
});

// --- 에이전트 배포(설치 안내) 페이지 ---
app.get('/setup', (req, res) => {
  const base = String(config.publicBaseUrl || 'https://pcoff.sanghak.kr').replace(/\/+$/, '');
  const tok = config.token;
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PC OFF 에이전트 설치</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
<style>
  header .brand{display:flex;min-width:0;align-items:center;gap:16px}
  .wrap{width:100%;max-width:none;margin:0;padding:16px 16px 28px}
  .step{width:100%;min-width:0;background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(250,252,255,.98));border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 14px;box-shadow:var(--shadow)}
  .step h3{margin:0;font-size:var(--title-size);line-height:1.3;font-weight:700}.step-head{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
  .setup-field{display:grid;grid-template-columns:180px minmax(0,1fr);gap:12px;align-items:center}
  .setup-field label{font-size:14px;font-weight:700;color:var(--muted)}
  .setup-field input{width:100%;height:36px;border:1px solid var(--line);border-radius:8px;padding:0 12px;font-size:14px;color:var(--text);background:#fff}
  pre{width:100%;max-width:100%;min-width:0;min-height:112px;background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:visible;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;box-shadow:0 14px 28px rgba(15,23,42,.18)}
  pre code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all}
  code{color:#a7f3d0}.kv{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
  .kv span{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:14px}
  .warn{color:var(--amber);font-size:14px}.copy-btn{flex:0 0 auto;border:1px solid #334155;border-radius:8px;background:#1f2937;color:#e5e7eb;padding:7px 10px;font-size:13px;font-weight:700;cursor:pointer}
  .copy-btn.copied{border-color:#10b981;color:#a7f3d0}
  @media (max-width:640px){header .brand{display:block}.wrap{padding:12px}.step{padding:14px}.step-head{align-items:flex-start}.setup-field{grid-template-columns:1fr}pre{font-size:12px}}
  @media (max-width:430px){
    body,body *{font-size:9px}
    header h1,.step h3{font-size:10px;line-height:1.2}
    .wrap{padding:8px 8px calc(76px + env(safe-area-inset-bottom))}
    .step{padding:6px;margin:0 0 7px}
    .step-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;margin-bottom:5px}
    .setup-field{display:grid;grid-template-columns:82px minmax(0,1fr);gap:5px}
    .setup-field label,.setup-field input,.warn,.kv span,.copy-btn,pre,code{font-size:9px}
    .setup-field input{height:26px;padding:0 6px}
    .copy-btn{height:26px;padding:0 7px}
    pre{min-height:0;padding:4px 5px 3px;line-height:1.2}
    .kv{gap:4px;margin:5px 0}
    .kv span{padding:3px 5px}
    .warn{margin:5px 0 0}
  }
</style></head><body class="setup-page">
<header><div class="brand"><h1>PC OFF 에이전트 설치</h1></div>
<div class="meta"><a href="/" style="color:var(--blue)">← 대시보드</a></div></header>
<div class="wrap">
  <div class="step">
    <div class="setup-field">
      <label for="agent-server">에이전트 설치 주소</label>
      <input id="agent-server" type="url" value="${escapeAttr(base)}" spellcheck="false" />
    </div>
    <p class="warn">주소를 변경하면 아래 macOS/Windows 설치 명령도 함께 변경됩니다.</p>
  </div>

  <div class="step">
    <div class="step-head"><h3>macOS 터미널 설치</h3><button type="button" class="copy-btn" data-copy-target="mac-command">복사</button></div>
    <pre><code id="mac-command"></code></pre>
    <p class="warn">PC-OFF Agent 앱 번들을 만들고 현재 사용자 LaunchAgent로 등록합니다.</p>
  </div>

  <div class="step">
    <div class="step-head"><h3>Windows 설치</h3><button type="button" class="copy-btn" data-copy-target="windows-command">복사</button></div>
    <pre><code id="windows-command"></code></pre>
  </div>

  <div class="step">
    <h3>수집 정보</h3>
    <div class="kv"><span>hostname</span><span>사용자명</span><span>OS</span><span>LAN IP</span><span>MAC 주소</span><span>잠금/해제/상태 보고 시각</span></div>
    <p class="warn">근로자 PC 모니터링은 사전 고지, 목적 제한, 내부 승인 절차가 필요할 수 있습니다.</p>
  </div>
</div>
<script>
  const token = ${JSON.stringify(tok)};
  const defaultBase = ${JSON.stringify(base)};
  const serverInput = document.getElementById('agent-server');
  const macCommand = document.getElementById('mac-command');
  const windowsCommand = document.getElementById('windows-command');
  function shellQuote(value) {
    return '"' + String(value).replace(/["\\\\$\`]/g, '\\\\$&') + '"';
  }
  function psSingleQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }
  function normalizedBase() {
    const value = (serverInput.value || defaultBase).trim().replace(/\\/+$/, '');
    return value || defaultBase;
  }
  function renderCommands() {
    const server = normalizedBase();
    macCommand.textContent = [
      'mkdir -p ~/pmon-agent && cd ~/pmon-agent',
      'rm -f pmon-agent.sh install.sh',
      'curl -fsSL ' + shellQuote(server + '/download/macos/pmon-agent.sh') + ' -o pmon-agent.sh',
      'curl -fsSL ' + shellQuote(server + '/download/macos/install.sh') + ' -o install.sh',
      'chmod +x install.sh',
      'PMON_SERVER=' + shellQuote(server) + ' PMON_TOKEN=' + shellQuote(token) + ' ./install.sh'
    ].join(' &&\\n');
    windowsCommand.textContent = [
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "',
      "$ErrorActionPreference='Stop';",
      'md $env:USERPROFILE\\\\pmon-agent -Force | Out-Null;',
      'cd $env:USERPROFILE\\\\pmon-agent;',
      'Remove-Item .\\\\pmon-agent.ps1,.\\\\install.ps1 -Force -ErrorAction SilentlyContinue;',
      'iwr ' + psSingleQuote(server + '/download/windows/pmon-agent.ps1') + ' -OutFile pmon-agent.ps1;',
      'iwr ' + psSingleQuote(server + '/download/windows/install.ps1') + ' -OutFile install.ps1;',
      '.\\\\install.ps1 -Server ' + psSingleQuote(server) + ' -Token ' + psSingleQuote(token) + '"'
    ].join('\\n');
  }
  serverInput.addEventListener('input', renderCommands);
  renderCommands();
  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      const text = target ? target.innerText : '';
      if (!text) return;
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      button.textContent = '복사됨';
      setTimeout(() => { button.classList.remove('copied'); button.textContent = '복사'; }, 1400);
    });
  });
</script>
<script type="module">import '/nav.js';</script></body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// --- 기간 감사 리포트 (근태·가동) ---
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function listDays(from, to) {
  const s = new Date(from + 'T00:00:00'); const e = new Date(to + 'T00:00:00');
  if (isNaN(s) || isNaN(e) || e < s) return null;
  const days = [];
  for (let d = new Date(s); d <= e && days.length <= 92; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  return days;
}
async function buildReport(from, to) {
  const days = listDays(from, to);
  if (!days) return null;
  const byHost = {};
  let thresholds = null, workOptions = null;
  for (const day of days) {
    const a = await computeAway(day);
    thresholds = a.thresholds; workOptions = a.workOptions;
    for (const m of a.machines) {
      if (m.arrival == null && m.awayCount === 0) continue; // 활동 없는 날 제외
      if (!byHost[m.hostname]) byHost[m.hostname] = { hostname: m.hostname, source: m.source, basis: m.basis, days: [] };
      byHost[m.hostname].days.push({
        date: day, arrival: m.arrival, departure: m.departure, departureEstimated: m.departureEstimated, lateArrival: m.lateArrival,
        awayCount: m.awayCount, totalAwaySec: m.totalAwaySec, longestAwaySec: m.longestAwaySec,
        presentSec: m.presentSec, longAway: m.longAway, frequent: m.frequent,
      });
    }
  }
  const machines = Object.values(byHost).map((mm) => {
    const t = { days: mm.days.length, presentSec: 0, awayCount: 0, totalAwaySec: 0, lateDays: 0 };
    for (const d of mm.days) { t.presentSec += d.presentSec; t.awayCount += d.awayCount; t.totalAwaySec += d.totalAwaySec; if (d.lateArrival) t.lateDays++; }
    t.avgPresentSec = t.days ? Math.round(t.presentSec / t.days) : 0;
    t.lateRate = t.days ? Math.round((t.lateDays / t.days) * 100) : 0;
    return { ...mm, totals: t };
  }).sort((a, b) => a.hostname.localeCompare(b.hostname));

  // 전체 요약
  const summary = {
    machineCount: machines.length,
    recordDays: machines.reduce((s, m) => s + m.totals.days, 0),
    totalPresentSec: machines.reduce((s, m) => s + m.totals.presentSec, 0),
    lateDays: machines.reduce((s, m) => s + m.totals.lateDays, 0),
    avgPresentSec: 0,
  };
  summary.avgPresentSec = summary.recordDays ? Math.round(summary.totalPresentSec / summary.recordDays) : 0;
  return { from, to, days: days.length, thresholds, workOptions, summary, machines };
}

app.get('/api/report', async (req, res) => {
  const today = new Date();
  const to = req.query.to || ymd(today);
  const from = req.query.from || ymd(new Date(today.getTime() - 6 * 86400000));
  const r = await buildReport(from, to);
  if (!r) return res.status(400).json({ ok: false, error: '날짜 범위 오류' });
  res.json({ ok: true, ...r });
});

app.get('/api/report.csv', async (req, res) => {
  const today = new Date();
  const to = req.query.to || ymd(today);
  const from = req.query.from || ymd(new Date(today.getTime() - 6 * 86400000));
  const r = await buildReport(from, to);
  if (!r) return res.status(400).send('날짜 범위 오류');
  const hms = (s) => `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
  const tm = (ms) => ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour12: false }) : '';
  const rows = [['날짜', 'PC', '기준', '출근', '퇴근', '지각', '자리비움횟수', '자리비움시간']];
  for (const m of r.machines) for (const d of m.days) {
    rows.push([d.date, m.hostname, m.basis === 'power' ? '전원' : '잠금', tm(d.arrival), tm(d.departure),
      d.lateArrival ? 'Y' : '', d.awayCount, hms(d.totalAwaySec)]);
  }
  const csv = '﻿' + rows.map((r2) => r2.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const filename = `pc-audit-${from}_${to}.csv`;
  uploadCsvBackup(filename, csv);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

function rangeBounds(from, to) {
  const s = new Date(from + 'T00:00:00'); const e = new Date(to + 'T00:00:00');
  if (isNaN(s) || isNaN(e) || e < s) return null;
  return {
    start: new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime(),
    end: new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime() + 86400000,
  };
}

// --- 이상 징후 감사 (심야·주말 사용 / 결근 / 단시간 근무) ---
app.get('/api/anomalies', async (req, res) => {
  const today = new Date();
  const to = req.query.to || ymd(today);
  const from = req.query.from || ymd(new Date(today.getTime() - 6 * 86400000));
  const rb = rangeBounds(from, to);
  if (!rb) return res.status(400).json({ ok: false, error: '날짜 범위 오류' });

  const NIGHT_END = 6, NIGHT_START = 22;     // 심야 06시 이전 / 22시 이후
  const SHORT_WORK = 4 * 3600;               // 단시간 근무 기준 4시간
  const out = [];

  // 심야 · 주말 사용 (켜짐/잠금해제 활동 기준)
  for (const e of await stmts.eventsByDay.all(rb.start, rb.end)) {
    if (e.type !== 'power_on' && e.type !== 'unlock') continue;
    const d = new Date(e.ts); const h = d.getHours(); const dow = d.getDay();
    const reasons = [];
    if (h >= NIGHT_START || h < NIGHT_END) reasons.push('심야');
    if (dow === 0 || dow === 6) reasons.push('주말');
    if (reasons.length) out.push({ ts: e.ts, hostname: e.hostname, source: e.source, type: e.type, reasons });
  }

  // 단시간 근무 · 결근 (평일 기준)
  const rep = await buildReport(from, to);
  for (const m of rep.machines) {
    const active = new Set(m.days.map((d) => d.date));
    const dates = m.days.map((d) => d.date).sort();
    const firstDay = dates[0], lastDay = dates[dates.length - 1];
    for (const d of m.days) {
      const dow = new Date(d.date + 'T00:00:00').getDay();
      if (dow >= 1 && dow <= 5 && d.presentSec > 0 && d.presentSec < SHORT_WORK) {
        out.push({ ts: d.arrival, hostname: m.hostname, source: m.source, type: 'short_work', reasons: ['단시간근무'], presentSec: d.presentSec, date: d.date });
      }
    }
    // 결근: 활동 기록 사이의 평일 중 기록이 없는 날
    if (firstDay && lastDay) {
      for (const day of listDays(firstDay, lastDay)) {
        const dow = new Date(day + 'T00:00:00').getDay();
        if (dow >= 1 && dow <= 5 && !active.has(day)) {
          out.push({ ts: new Date(day + 'T09:00:00').getTime(), hostname: m.hostname, source: m.source, type: 'absent', reasons: ['결근(무활동)'], date: day });
        }
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  res.json({ ok: true, from, to, count: out.length, anomalies: out });
});

// --- 감사 로그 검색/필터 (PC·기간·이벤트 종류) + PC 상세 ---
async function searchEvents(from, to, machine, type) {
  const rb = rangeBounds(from, to);
  if (!rb) return null;
  let evs = await stmts.eventsByDay.all(rb.start, rb.end);
  evs = visibleUserEvents(evs);
  if (machine) evs = evs.filter((e) => e.hostname === machine);
  if (type) evs = evs.filter((e) => e.type === type);
  return evs;
}
app.get('/api/events/search', async (req, res) => {
  const today = new Date();
  const to = req.query.to || ymd(today);
  const from = req.query.from || ymd(new Date(today.getTime() - 6 * 86400000));
  const evs = await searchEvents(from, to, req.query.machine, req.query.type);
  if (!evs) return res.status(400).json({ ok: false, error: '날짜 범위 오류' });
  res.json({ ok: true, from, to, count: evs.length, events: evs.slice(0, 3000) });
});
app.get('/api/events/search.csv', async (req, res) => {
  const today = new Date();
  const to = req.query.to || ymd(today);
  const from = req.query.from || ymd(new Date(today.getTime() - 6 * 86400000));
  const evs = await searchEvents(from, to, req.query.machine, req.query.type);
  if (!evs) return res.status(400).send('날짜 범위 오류');
  const TYPE_KO2 = { power_on: '전원', login: '로그인', unlock: '잠금해제', lock: '잠금', shutdown: '종료' };
  const rows = [['시각', 'PC', '방식', '이벤트']];
  for (const e of evs) rows.push([new Date(e.ts).toLocaleString('ko-KR', { hour12: false }), e.hostname, e.source === 'ping' ? '핑' : '에이전트', TYPE_KO2[e.type] || e.type]);
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const filename = `pc-events-${from}_${to}.csv`;
  uploadCsvBackup(filename, csv);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// --- 사각지대 점검 (보고 끊긴 에이전트 / 오프라인 핑 PC) ---
app.get('/api/coverage', async (req, res) => {
  const hours = Math.max(1, parseInt(req.query.hours || '24', 10));
  const range = req.query.from && req.query.to ? rangeBounds(req.query.from, req.query.to) : null;
  if (req.query.from && req.query.to && !range) return res.status(400).json({ ok: false, error: '날짜 범위 오류' });
  const now = range ? range.end : Date.now();
  const thresh = hours * 3600000;
  const machineRows = await stmts.listMachines.all();
  const items = machineRows.filter((m) => !range || m.first_seen <= range.end).map((m) => {
    const ageMs = now - m.last_seen;
    let blind = false, kind = '정상';
    if (m.source === 'agent') {
      if (ageMs > thresh) { blind = true; kind = '보고 끊김'; }
    } else if (m.last_state === 'offline') {
      blind = true; kind = '오프라인';
    }
    return {
      hostname: m.hostname, source: m.source, last_state: m.last_state,
      ip: m.local_ip || m.ip, mac: m.mac, last_seen: m.last_seen,
      ageSec: Math.round(ageMs / 1000), blind, kind,
    };
  });
  const blind = items.filter((i) => i.blind).sort((a, b) => b.ageSec - a.ageSec);
  res.json({ ok: true, hours, total: items.length, blindCount: blind.length, blind });
});

app.get('/report', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'report.html')));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

ready
  .then(async () => {
    app.listen(config.port, config.host, async () => {
      console.log(`PC 모니터링 서버 실행 중: http://localhost:${config.port}  (바인딩 ${config.host}:${config.port})`);
      console.log(`에이전트 토큰: ${config.token}`);
      const archived = await archiveOrphanPingMachines();
      if (archived) console.log(`감시 해제된 핑 머신 ${archived}개 보관 처리됨 (로그 유지)`);
      pinger.start();
      // 오프라인 3시간+ 인데 종료 보고가 없는 에이전트에 '종료(추정)' 이벤트 자동 기록 (전원↔종료 짝 맞춤)
      const closeStale = () => closeStaleOfflineSessions()
        .then((n) => { if (n) console.log(`추정 종료 이벤트 ${n}건 자동 기록`); })
        .catch((err) => console.error('closeStaleOfflineSessions 실패:', err.message));
      closeStale();
      setInterval(closeStale, 5 * 60 * 1000);
    });
  })
  .catch((error) => {
    console.error('PC 사용 현황 DB 초기화 실패:', error);
    process.exit(1);
  });

module.exports = app;
