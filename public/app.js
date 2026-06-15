'use strict';

const STATE_LABEL = { unlocked: '온라인', locked: '잠금(자리비움)', online: '온라인', offline: '오프라인', unknown: '—' };
const SOURCE_LABEL = { agent: '에이전트', ping: '핑' };
const TYPE_LABEL = { power_on: '전원', login: '로그인', unlock: '잠금해제', lock: '잠금', shutdown: '종료' };
let machinesCache = [];
let lastNow = Date.now();
let modalMachine = null;
let modalExportRows = [];
let modalLogEventsCache = [];
let modalLogPage = 1;
let logEventsCache = [];
let logPage = 1;
const LOG_PAGE_SIZE = 10;
const portalView = new URLSearchParams(window.location.search).get('view');
if (['dashboard', 'machines'].includes(portalView)) {
  document.body.classList.add('portal-embedded', `portal-view-${portalView}`);
  window.addEventListener('DOMContentLoaded', () => {
    const title = document.querySelector('header h1');
    const description = document.querySelector('header p');
    if (portalView === 'dashboard') {
      if (title) title.textContent = 'PC-OFF 대시보드';
      if (description) description.textContent = 'PC-OFF 통계와 운영 현황을 요약합니다.';
    }
    if (portalView === 'machines') {
      if (title) title.textContent = 'PC 현황';
      if (description) description.textContent = 'PC별 접속, 잠금, 사용 이벤트를 확인합니다.';
    }
  });
}

function fmtTime(ms) {
  if (!ms) return '—';
  const value = typeof ms === 'string' && /^\d+$/.test(ms) ? Number(ms) : ms;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function ago(ms, now) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

function fmtDateTime(ms) {
  if (!ms) return '—';
  const value = typeof ms === 'string' && /^\d+$/.test(ms) ? Number(ms) : ms;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((p) => p.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function machineStatus(m) {
  if (!m.online || m.state === 'offline') return { key: 'offline', label: '오프라인' };
  if (m.state === 'locked') return { key: 'locked', label: '잠금(자리비움)' };
  return { key: 'online', label: '온라인' };
}

async function load() {
  let data;
  try {
    data = await (await fetch('/api/machines')).json();
  } catch {
    document.getElementById('summary').textContent = '서버 연결 실패';
    return;
  }

  const machines = data.machines || [];
  const now = data.now || Date.now();
  machinesCache = machines;
  lastNow = now;

  const online = machines.filter((m) => m.online && m.state !== 'offline').length;
  const offline = machines.filter((m) => !m.online || m.state === 'offline').length;
  const locked = machines.filter((m) => m.online && m.state === 'locked').length;
  const unmapped = machines.filter((m) => !(m.username || '').trim()).length;

  document.getElementById('summary').textContent = `총 ${machines.length}대 · 온라인 ${online} · 잠금 ${locked} · 오프라인 ${offline} · 맵핑 안됨 ${unmapped}`;
  document.getElementById('updated').textContent = fmtTime(now);
  document.getElementById('metric-total').textContent = machines.length;
  document.getElementById('metric-active').textContent = online;
  document.getElementById('metric-locked').textContent = locked;
  document.getElementById('metric-offline').textContent = unmapped;
  syncLogUsers();

  renderMachines();
}

function filteredMachines() {
  const q = (document.getElementById('machine-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('machine-status')?.value || '';
  return machinesCache.filter((m) => {
    if (status && machineStatus(m).key !== status) return false;
    if (!q) return true;
    const haystack = [m.hostname, m.username, m.os, m.local_ip, m.ip, m.mac].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderMachines() {
  const machines = filteredMachines();
  const machineCount = document.getElementById('machine-count');
  if (machineCount) machineCount.textContent = `${machines.length}대 표시`;
  const grid = document.getElementById('machine-grid');
  if (!machinesCache.length) {
    grid.innerHTML = '';
    return;
  }
  if (!machines.length) {
    grid.innerHTML = '<div class="empty">조건에 맞는 PC가 없습니다.</div>';
    return;
  }

  grid.innerHTML = machines.map((m) => {
    const ipShown = m.local_ip || m.ip || '—';
    const status = machineStatus(m);
    const personName = m.username || '';
    const mappingLabel = personName || '맵핑 안됨';
    const mappingClass = personName ? 'person-name' : 'person-name mapping-missing';
    const hostName = m.hostname || '';
    const hostLength = [...hostName].length;
    const hostSize = hostLength > 18 ? 8 : hostLength > 14 ? 9 : hostLength > 10 ? 10 : 11;
    return `
      <article class="machine-card status-${status.key}" data-id="${m.id}" title="${escapeAttr(m.hostname || '')}" style="--host-size: ${hostSize}px">
        <div class="machine-name">
          <b class="${mappingClass}">${escapeHtml(mappingLabel)}</b>
          <span class="host-name">${escapeHtml(hostName)}</span>
          <span class="mono ip-name">${escapeHtml(ipShown)}</span>
        </div>
        <span class="cube-status">${status.label}</span>
      </article>`;
  }).join('');

  grid.querySelectorAll('.machine-card').forEach((card) => {
    card.addEventListener('click', () => {
      const machine = machinesCache.find((m) => String(m.id) === String(card.dataset.id));
      if (machine) openMachineDetail(machine);
    });
  });
}

async function saveUsername(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector('input');
  const select = form.querySelector('select');
  const button = form.querySelector('button');
  const username = input.value.trim();
  const workType = select.value;
  button.disabled = true;
  try {
    const data = await (await fetch(`/api/machines/${form.dataset.id}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, workType }),
    })).json();
    if (!data.ok) throw new Error(data.error || '저장 실패');
    const machine = machinesCache.find((m) => String(m.id) === String(form.dataset.id));
    if (machine) {
      machine.username = data.username || '';
      machine.work_start = data.work_start;
      machine.work_end = data.work_end;
    }
    renderMachines();
    syncLogUsers();
    loadLog();
    loadAway();
    button.classList.add('saved');
    button.textContent = '완료';
    setTimeout(() => { button.classList.remove('saved'); button.textContent = '저장'; }, 1200);
  } catch (error) {
    alert(error.message || '저장 실패');
  } finally {
    button.disabled = false;
  }
}

async function importDirectoryFile(file) {
  if (!file) return;
  const button = document.getElementById('directory-import');
  button.disabled = true;
  button.textContent = '가져오는 중';
  try {
    const payload = {};
    if (/\.(xlsx|xls)$/i.test(file.name || '')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      payload.filename = file.name;
      payload.base64 = btoa(binary);
    } else {
      payload.csv = await file.text();
    }
    const data = await (await fetch('/api/device-directory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
    if (!data.ok) throw new Error(data.error || '가져오기 실패');
    button.textContent = `반영 ${data.applied}대`;
    await load();
    await loadLog();
    await loadAway();
    setTimeout(() => { button.textContent = '가져오기'; }, 1600);
  } catch (error) {
    alert(error.message || '가져오기 실패');
    button.textContent = '가져오기';
  } finally {
    button.disabled = false;
  }
}

async function openDirectoryModal() {
  const modal = document.getElementById('directory-modal');
  const list = document.getElementById('directory-rows');
  modal.classList.remove('hidden');
  list.innerHTML = '<div class="empty">불러오는 중…</div>';
  let data;
  try {
    data = await (await fetch('/api/device-directory')).json();
  } catch {
    list.innerHTML = '<div class="empty">불러오기 실패</div>';
    return;
  }
  const rows = data.rows || [];
  if (!rows.length) {
    list.innerHTML = '<div class="empty">등록된 사용자가 없습니다.</div>';
    return;
  }
  list.innerHTML = `
    <div class="directory-row directory-header">
      <span>사용자</span><span>mac</span><span>ip</span><span>저장</span>
    </div>
    ${rows.map((row) => {
      const ips = String(row.ip || row.connected_ip || '')
        .split(/[\s,]+/)
        .filter(Boolean)
        .join(', ');
      return `
      <div class="directory-row" data-id="${row.id}">
        <input type="text" name="username" value="${escapeAttr(row.username || '')}" />
        <input type="text" name="mac" value="${escapeAttr(row.mac || '')}" />
        <input type="text" name="ip" value="${escapeAttr(ips)}" placeholder="192.168.0.1, 192.168.0.2" />
        <button type="button" class="directory-save">저장</button>
      </div>
    `;
    }).join('')}
  `;
}

async function saveDirectoryRow(button) {
  const row = button.closest('.directory-row[data-id]');
  if (!row) return;
  const body = {
    username: row.querySelector('[name="username"]').value.trim(),
    mac: row.querySelector('[name="mac"]').value.trim(),
    ip: row.querySelector('[name="ip"]').value
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .join(', '),
  };
  button.disabled = true;
  button.textContent = '저장 중';
  try {
    const data = await (await fetch(`/api/device-directory/${row.dataset.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();
    if (!data.ok) throw new Error(data.error || '저장 실패');
    button.textContent = '완료';
    await load();
    setTimeout(() => { button.textContent = '저장'; }, 1200);
  } catch (error) {
    alert(error.message || '저장 실패');
    button.textContent = '저장';
  } finally {
    button.disabled = false;
  }
}

function syncLogUsers() {
  const select = document.getElementById('log-user');
  if (!select) return;
  const current = select.value;
  const users = [...new Set(machinesCache.map((m) => (m.username || '').trim()).filter(Boolean))].sort();
  select.innerHTML = '<option value="">전체 사용자</option>' + users.map((u) => `<option value="${escapeAttr(u)}">${escapeHtml(u)}</option>`).join('');
  if (users.includes(current)) select.value = current;
}

async function openMachineDetail(machine, fromDate, toDate) {
  modalMachine = machine;
  const from = fromDate || todayStr();
  const to = toDate || from;
  document.getElementById('modal-date-from').value = from;
  document.getElementById('modal-date-to').value = to;
  document.getElementById('modal-title').textContent = machine.hostname || 'PC 상세';
  document.getElementById('modal-subtitle').textContent = `${machine.hostname || '—'} · ${machine.local_ip || machine.ip || 'IP 없음'} · ${SOURCE_LABEL[machine.source] || machine.source}`;
  document.getElementById('modal').classList.remove('hidden');
  renderMachineDetailInfo(machine);
  renderSecurityTools(machine.security_tools);
  modalExportRows = [];
  await Promise.all([loadModalAway(machine, from, to), loadModalIpHistory(machine, from, to), loadModalLogs(machine, from, to)]);
}

function renderMachineDetailInfo(machine) {
  const el = document.getElementById('machine-detail-info');
  const status = machineStatus(machine);
  const rows = [
    ['사용자', machine.username || '맵핑 안됨'],
    ['PC 이름', machine.hostname],
    ['현재 상태', status.label],
    ['VPN 접속', machine.vpn_connected ? '접속됨' : '미접속'],
    ['VPN IP', machine.vpn_ip],
    ['로컬 IP', machine.local_ip],
    ['접속 IP', machine.ip],
    ['MAC Address', machine.mac],
    ['OS', machine.os],
    ['수집 방식', SOURCE_LABEL[machine.source] || machine.source],
    ['최초 보고', fmtDateTime(machine.first_seen)],
    ['최근 보고', fmtDateTime(machine.last_seen)],
    ['상태 저장 시각', fmtDateTime(machine.status_updated_at)],
    ['마지막 이벤트', machine.last_event_type ? `${TYPE_LABEL[machine.last_event_type] || machine.last_event_type} · ${fmtDateTime(machine.last_event_at)}` : '—'],
  ];
  el.innerHTML = rows.map(([label, value]) => `
    <div class="detail-info-item">
      <span>${escapeHtml(label)}</span>
      <strong class="${label === '사용자' && !machine.username ? 'mapping-missing' : ''}">${escapeHtml(value || '—')}</strong>
    </div>
  `).join('');
}

async function loadModalIpHistory(machine, from, to) {
  const tbody = document.getElementById('modal-ip-rows');
  tbody.innerHTML = '<tr><td colspan="7" class="empty">불러오는 중…</td></tr>';
  let data;
  try {
    data = await (await fetch(`/api/machines/${machine.id}/ip-history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json();
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">불러오기 실패</td></tr>';
    return;
  }
  const rows = data.rows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">해당 기간의 IP 변경 이력이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td class="mono">${fmtDateTime(row.changed_at)}</td>
      <td class="mono">${escapeHtml(row.remote_ip || '—')}</td>
      <td class="mono">${escapeHtml(row.local_ip || '—')}</td>
      <td>${row.vpn_connected ? '<span class="tool-badge ok">접속</span>' : '<span class="tool-badge unknown">미접속</span>'}</td>
      <td class="mono">${escapeHtml(row.vpn_ip || '—')}</td>
      <td class="mono">${escapeHtml(row.mac || '—')}</td>
      <td>${escapeHtml(row.reason === 'initial' ? '최초 수집' : '변경 감지')}</td>
    </tr>
  `).join('');
}

function toolStateText(state) {
  if (!state) return { cls: 'unknown', install: '에이전트 업데이트 필요', run: '수집값 없음' };
  const install = state.installed === true ? '설치됨' : state.installed === false ? '미설치' : '설치 미수집';
  const run = state.running === true ? '실행중' : state.running === false ? '중지' : '실행 미수집';
  const cls = state.installed === true && state.running === true
    ? 'ok'
    : state.installed === false || state.running === false
      ? 'bad'
      : 'unknown';
  return { cls, install, run };
}

function renderSecurityTools(tools) {
  const el = document.getElementById('security-tools');
  const rows = [
    ['V3', tools?.v3],
    ['OfficeKeeper', tools?.officekeeper],
  ];
  el.innerHTML = rows.map(([name, state]) => {
    const status = toolStateText(state);
    return `
    <div class="security-tool">
      <div>
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(status.install)} · ${escapeHtml(status.run)}</span>
      </div>
      <span class="tool-badge ${status.cls}">${escapeHtml(status.cls === 'ok' ? '정상' : status.cls === 'bad' ? '확인 필요' : '미수집')}</span>
    </div>
  `;
  }).join('');
}

function dateRange(from, to) {
  const dates = [];
  let current = from || todayStr();
  const end = to && to >= current ? to : current;
  for (let guard = 0; current <= end && guard < 93; guard += 1) {
    dates.push(current);
    current = shiftDate(current, 1);
  }
  return dates;
}

async function loadModalAway(machine, from, to) {
  const tbody = document.getElementById('modal-away-rows');
  tbody.innerHTML = '<tr><td colspan="7" class="empty">불러오는 중…</td></tr>';
  const rows = [];
  try {
    for (const date of dateRange(from, to)) {
      const data = await (await fetch(`/api/away?date=${date}`)).json();
      const m = (data.machines || []).find((item) => String(item.id) === String(machine.id));
      if (m && m.arrival != null) rows.push({ date, ...m });
    }
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">불러오기 실패</td></tr>';
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">해당 기간에 활동 기록이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    const flags = [];
    if (m.lateArrival) flags.push('<span class="flag flag-late">지각</span>');
    if (m.longAway) flags.push('<span class="flag flag-long">오래 비움</span>');
    if (m.frequent) flags.push('<span class="flag flag-freq">자주</span>');
    modalExportRows.push({
      section: '자리비움',
      date: m.date,
      time: '',
      event: '',
      source: SOURCE_LABEL[machine.source] || machine.source,
      arrival: fmtTime(m.arrival),
      departure: m.departure ? fmtTime(m.departure) + (m.departureEstimated ? ' (추정)' : '') : '',
      awayCount: m.awayCount,
      totalAway: fmtDur(m.totalAwaySec),
      longestAway: fmtDur(m.longestAwaySec),
      flags: flags.map((html) => html.replace(/<[^>]+>/g, '')).join(' '),
    });
    return `
    <tr class="${m.longAway || m.frequent || m.lateArrival ? 'flagged' : ''}">
      <td class="mono">${escapeHtml(m.date)}</td>
      <td class="mono ${m.lateArrival ? 'late' : ''}">${fmtTime(m.arrival)}</td>
      <td class="mono">${m.departure ? fmtTime(m.departure) + (m.departureEstimated ? ' <span class="muted">(추정)</span>' : '') : '<span class="muted">종료 기록 없음</span>'}</td>
      <td class="mono">${m.awayCount}회</td>
      <td class="mono">${fmtDur(m.totalAwaySec)}</td>
      <td class="mono">${fmtDur(m.longestAwaySec)}</td>
      <td>${flags.join(' ') || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

async function loadModalLogs(machine, from, to) {
  const tbody = document.getElementById('modal-log-rows');
  const pagination = document.getElementById('modal-log-pagination');
  tbody.innerHTML = '<tr><td colspan="4" class="empty">불러오는 중…</td></tr>';
  pagination.innerHTML = '';
  const rows = [];
  try {
    for (const date of dateRange(from, to)) {
      const data = await (await fetch(`/api/machines/${machine.id}/events?date=${date}`)).json();
      const events = (data.events || []).filter((e) => e.type !== 'heartbeat');
      rows.push(...events.map((event) => ({ date, ...event })));
    }
  } catch {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">불러오기 실패</td></tr>';
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">해당 기간의 이벤트가 없습니다.</td></tr>';
    return;
  }
  modalLogEventsCache = rows;
  modalLogPage = 1;
  for (const event of rows) {
    modalExportRows.push({
      section: '일별로그',
      date: event.date,
      time: fmtTime(event.ts),
      event: (TYPE_LABEL[event.type] || event.type) + (event.estimated ? ' (추정)' : ''),
      source: SOURCE_LABEL[machine.source] || machine.source,
      arrival: '',
      departure: '',
      awayCount: '',
      totalAway: '',
      longestAway: '',
      flags: '',
    });
  }
  renderModalLogPage(machine);
}

function renderModalLogPage(machine = modalMachine) {
  const tbody = document.getElementById('modal-log-rows');
  const pagination = document.getElementById('modal-log-pagination');
  const maxPage = Math.max(1, Math.ceil(modalLogEventsCache.length / LOG_PAGE_SIZE));
  if (modalLogPage > maxPage) modalLogPage = maxPage;
  const start = (modalLogPage - 1) * LOG_PAGE_SIZE;
  const pageRows = modalLogEventsCache.slice(start, start + LOG_PAGE_SIZE);
  tbody.innerHTML = pageRows.map((event) => {
    return `
    <tr>
      <td class="mono">${escapeHtml(event.date)}</td>
      <td class="mono">${fmtTime(event.ts)}</td>
      <td><span class="badge ${event.type}">${TYPE_LABEL[event.type] || event.type}</span>${event.estimated ? ' <span class="muted">(추정)</span>' : ''}</td>
      <td><span class="src src-${machine.source}">${SOURCE_LABEL[machine.source] || machine.source}</span></td>
    </tr>
  `;
  }).join('');
  if (maxPage <= 1) {
    pagination.innerHTML = `<span class="page-summary">총 ${modalLogEventsCache.length}건</span>`;
    return;
  }
  const pages = Array.from({ length: maxPage }, (_, index) => index + 1);
  pagination.innerHTML = `
    <span class="page-summary">총 ${modalLogEventsCache.length}건 · ${modalLogPage}/${maxPage}</span>
    ${pages.map((page) => `<button type="button" class="${page === modalLogPage ? 'active' : ''}" data-modal-page="${page}">${page}</button>`).join('')}
  `;
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal').classList.add('hidden');
});
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') document.getElementById('modal').classList.add('hidden');
});
function reloadModalPeriod() {
  if (!modalMachine) return;
  const from = document.getElementById('modal-date-from').value || todayStr();
  const to = document.getElementById('modal-date-to').value || from;
  openMachineDetail(modalMachine, from, to);
}
document.getElementById('modal-date-from').addEventListener('change', reloadModalPeriod);
document.getElementById('modal-date-to').addEventListener('change', reloadModalPeriod);

async function disableModalMachineMonitoring() {
  if (!modalMachine) return;
  const label = modalMachine.hostname || modalMachine.username || '선택한 PC';
  if (!confirm(`${label} 에이전트 수집을 끄겠습니까?\n설치는 유지되지만 이후 보고 데이터는 저장하지 않습니다.`)) return;
  const button = document.getElementById('modal-disable-monitoring');
  button.disabled = true;
  button.textContent = '처리 중';
  try {
    const data = await (await fetch(`/api/machines/${modalMachine.id}/disable-monitoring`, { method: 'POST' })).json();
    if (!data.ok) throw new Error(data.error || '감시 끄기 실패');
    document.getElementById('modal').classList.add('hidden');
    await load();
  } catch (error) {
    alert(error.message || '감시 끄기 실패');
  } finally {
    button.disabled = false;
    button.textContent = '감시 끄기';
  }
}
document.getElementById('modal-disable-monitoring').addEventListener('click', disableModalMachineMonitoring);

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadModalCsv() {
  if (!modalMachine) return;
  const header = ['구분', '일자', '시각', '이벤트', '방식', '출근', '퇴근', '자리비움횟수', '총시간', '최장', '표시'];
  const rows = modalExportRows.map((row) => [
    row.section, row.date, row.time, row.event, row.source, row.arrival, row.departure,
    row.awayCount, row.totalAway, row.longestAway, row.flags,
  ]);
  const csv = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const from = document.getElementById('modal-date-from').value || todayStr();
  const to = document.getElementById('modal-date-to').value || from;
  link.href = URL.createObjectURL(blob);
  link.download = `pc-detail-${modalMachine.hostname || 'machine'}-${from}-${to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
document.getElementById('modal-csv').addEventListener('click', downloadModalCsv);

function shiftDate(str, delta) {
  const d = new Date(`${str}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + delta);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

async function loadLog() {
  const date = document.getElementById('log-date').value || todayStr();
  const username = document.getElementById('log-user')?.value || '';
  const params = new URLSearchParams({ date });
  if (username) params.set('username', username);
  document.getElementById('log-csv').href = `/api/logs.csv?${params.toString()}`;
  const tbody = document.getElementById('log-rows');
  let data;
  try {
    data = await (await fetch(`/api/logs?${params.toString()}`)).json();
  } catch {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">불러오기 실패</td></tr>';
    document.getElementById('log-pagination').innerHTML = '';
    return;
  }
  logEventsCache = data.events || [];
  if (!logEventsCache.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">해당 날짜의 이벤트가 없습니다.</td></tr>';
    document.getElementById('log-pagination').innerHTML = '';
    return;
  }
  const maxPage = Math.max(1, Math.ceil(logEventsCache.length / LOG_PAGE_SIZE));
  if (logPage > maxPage) logPage = maxPage;
  renderLogPage();
}

function renderLogPage() {
  const tbody = document.getElementById('log-rows');
  const pagination = document.getElementById('log-pagination');
  const maxPage = Math.max(1, Math.ceil(logEventsCache.length / LOG_PAGE_SIZE));
  const start = (logPage - 1) * LOG_PAGE_SIZE;
  const pageRows = logEventsCache.slice(start, start + LOG_PAGE_SIZE);
  tbody.innerHTML = pageRows.map((e) => `
    <tr>
      <td class="mono">${fmtTime(e.ts)}</td>
      <td><span class="badge ${e.type}">${TYPE_LABEL[e.type] || e.type}</span>${e.estimated ? ' <span class="muted">(추정)</span>' : ''}</td>
      <td class="host">${escapeHtml(e.hostname)}</td>
      <td>${escapeHtml(e.username || '—')}</td>
      <td>${escapeHtml(STATE_LABEL[e.event_status] || STATE_LABEL[e.current_status] || STATE_LABEL[e.last_state] || e.event_status || e.current_status || e.last_state || '—')}</td>
      <td class="mono">${escapeHtml(e.ip || '—')}</td>
      <td class="mono">${escapeHtml(e.local_ip || '—')}</td>
      <td>${e.vpn_connected ? '<span class="tool-badge ok">접속</span>' : '<span class="tool-badge unknown">미접속</span>'}</td>
      <td class="mono">${escapeHtml(e.vpn_ip || '—')}</td>
      <td class="mono">${escapeHtml(e.mac || '—')}</td>
      <td class="mono">${fmtTime(e.received_at)}</td>
      <td><span class="src src-${e.source}">${SOURCE_LABEL[e.source] || e.source}</span></td>
    </tr>
  `).join('');
  if (maxPage <= 1) {
    pagination.innerHTML = `<span class="page-summary">총 ${logEventsCache.length}건</span>`;
    return;
  }
  const pages = Array.from({ length: maxPage }, (_, index) => index + 1);
  pagination.innerHTML = `
    <span class="page-summary">총 ${logEventsCache.length}건 · ${logPage}/${maxPage}</span>
    ${pages.map((page) => `<button type="button" class="${page === logPage ? 'active' : ''}" data-page="${page}">${page}</button>`).join('')}
  `;
}

function fmtDur(sec) {
  if (!sec) return '0분';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${h}시간 ${m}분`;
  if (h) return `${h}시간`;
  if (m) return `${m}분`;
  return `${sec}초`;
}

async function loadAway() {
  const date = document.getElementById('away-date').value || todayStr();
  const tbody = document.getElementById('away-rows');
  let data;
  try {
    data = await (await fetch(`/api/away?date=${date}`)).json();
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">불러오기 실패</td></tr>';
    return;
  }
  document.getElementById('away-note').textContent = '';

  const rows = (data.machines || []).filter((m) => m.arrival != null);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">해당 날짜에 활동 기록이 없습니다.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    const flags = [];
    if (m.lateArrival) flags.push('<span class="flag flag-late">지각</span>');
    if (m.longAway) flags.push('<span class="flag flag-long">오래 비움</span>');
    if (m.frequent) flags.push('<span class="flag flag-freq">자주</span>');
    return `
      <tr class="${m.longAway || m.frequent || m.lateArrival ? 'flagged' : ''}">
        <td class="host">${escapeHtml(m.username || m.hostname)}</td>
        <td class="mono ${m.lateArrival ? 'late' : ''}">${fmtTime(m.arrival)}</td>
        <td class="mono">${m.departure ? fmtTime(m.departure) + (m.departureEstimated ? ' <span class="muted">(추정)</span>' : '') : '<span class="muted">종료 기록 없음</span>'}</td>
        <td class="mono">${m.awayCount}회</td>
        <td class="mono">${fmtDur(m.totalAwaySec)}</td>
        <td class="mono">${fmtDur(m.longestAwaySec)}</td>
        <td>${flags.join(' ') || '<span class="muted">—</span>'}</td>
      </tr>`;
  }).join('');
}

// ===== 통계 대시보드 =====
const STATS_PALETTE = ['#2563eb', '#0f9f6e', '#b7791f', '#d14343', '#8b5cf6', '#0891b2', '#db2777', '#64748b'];
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS_COLORS = { online: '#0f9f6e', locked: '#b7791f', offline: '#94a3b8', unknown: '#cbd5e1' };

function svgEl(w, h, inner) {
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}
function emptyChart(msg) { return `<div class="chart-empty">${escapeHtml(msg || '데이터 없음')}</div>`; }

function donutChart(data) {
  const items = data.filter((d) => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0);
  if (!total) return emptyChart();
  const cx = 90, cy = 90, r = 72, rin = 46;
  let a0 = -Math.PI / 2;
  const arcs = items.map((d) => {
    const frac = d.value / total;
    let a1 = a0 + frac * Math.PI * 2;
    if (items.length === 1) a1 = a0 + Math.PI * 1.9999;
    const large = frac > 0.5 ? 1 : 0;
    const p = (ang, rad) => `${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    const path = `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, rin)} A${rin} ${rin} 0 ${large} 0 ${p(a0, rin)} Z`;
    a0 = a1;
    return `<path d="${path}" fill="${d.color}"><title>${escapeHtml(d.label)}: ${d.value}</title></path>`;
  }).join('');
  const legend = data.map((d) =>
    `<div class="leg"><i style="background:${d.color}"></i>${escapeHtml(d.label)} <b>${d.value}</b></div>`).join('');
  return `<div class="donut-wrap">${svgEl(180, 180, `${arcs}<text x="${cx}" y="${cy - 2}" class="donut-total">${total}</text><text x="${cx}" y="${cy + 17}" class="donut-cap">합계</text>`)}<div class="chart-legend">${legend}</div></div>`;
}

function vbars(items, opts = {}) {
  if (!items.some((i) => i.value > 0)) return emptyChart();
  const W = Math.max(340, items.length * 26 + 44), H = 188, pad = { l: 30, r: 10, t: 16, b: 26 };
  const max = Math.max(1, ...items.map((i) => i.value));
  const bw = (W - pad.l - pad.r) / items.length;
  const color = opts.color || '#2563eb';
  let g = '';
  items.forEach((it, i) => {
    const h = (H - pad.t - pad.b) * (it.value / max);
    const x = pad.l + i * bw, y = H - pad.b - h;
    g += `<rect x="${(x + bw * 0.16).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${color}"><title>${escapeHtml(it.label)}: ${it.value}</title></rect>`;
    if (it.value > 0 && items.length <= 24) g += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="bar-val">${it.value}</text>`;
    g += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - pad.b + 14}" class="bar-lab">${escapeHtml(it.label)}</text>`;
  });
  return svgEl(W, H, `<line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" class="axis"/>${g}`);
}

function hbars(items) {
  if (!items.length || !items.some((i) => i.value > 0)) return emptyChart();
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((it) => {
    const pct = Math.round((it.value / max) * 100);
    return `<div class="hbar-row"><span class="hbar-lab" title="${escapeAttr(it.label)}">${escapeHtml(it.label)}</span><span class="hbar-track"><span class="hbar-fill" style="width:${pct}%;background:${it.color || '#0f9f6e'}"></span></span><b class="hbar-val">${it.value}</b></div>`;
  }).join('')}</div>`;
}

function statCard(title, body, wide) {
  return `<div class="stat-card${wide ? ' wide' : ''}"><h3>${escapeHtml(title)}</h3>${body}</div>`;
}

async function loadStats() {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;
  const from = document.getElementById('stats-from').value;
  const to = document.getElementById('stats-to').value;
  let data;
  try {
    const q = from && to ? `?from=${from}&to=${to}` : '';
    data = await (await fetch('/api/stats' + q)).json();
    if (!data.ok) throw new Error(data.error || '조회 실패');
  } catch (error) {
    grid.innerHTML = `<div class="empty">통계 조회 실패: ${escapeHtml(error.message)}</div>`;
    return;
  }
  renderStats(data);
}

function renderStats(d) {
  const k = d.kpi || {};
  const kpis = [
    ['전체 PC', k.total || 0, ''],
    ['온라인', k.online || 0, 'kpi-ok'],
    ['잠금', k.locked || 0, 'kpi-warn'],
    ['오프라인', k.offline || 0, 'kpi-muted'],
    ['VPN 접속', k.vpn || 0, ''],
    ['보고 끊김', k.blind || 0, k.blind ? 'kpi-bad' : ''],
  ];
  document.getElementById('stats-kpis').innerHTML = kpis.map(([l, v, c]) =>
    `<div class="kpi ${c}"><span>${l}</span><strong>${v}</strong></div>`).join('');

  const statusData = Object.entries(d.status || {}).map(([key, v], i) =>
    ({ label: STATE_LABEL[key] || key, value: v, color: STATUS_COLORS[key] || STATS_PALETTE[i % STATS_PALETTE.length] }));
  const osData = Object.entries(d.os || {}).map(([key, v], i) =>
    ({ label: key, value: v, color: STATS_PALETTE[i % STATS_PALETTE.length] }));
  const vpn = d.vpn || { connected: 0, disconnected: 0 };
  const vpnData = [
    { label: 'VPN 접속', value: vpn.connected, color: '#2563eb' },
    { label: '미접속', value: vpn.disconnected, color: '#cbd5e1' },
  ];
  const sec = d.security || {};
  const secBars = [
    { label: `V3 설치`, value: sec.v3Installed || 0, color: '#0f9f6e' },
    { label: `V3 실행`, value: sec.v3Running || 0, color: '#0891b2' },
    { label: `OfficeKeeper 설치`, value: sec.okInstalled || 0, color: '#8b5cf6' },
    { label: `OfficeKeeper 실행`, value: sec.okRunning || 0, color: '#db2777' },
  ];
  const weekday = (d.weekday || []).map((w) => ({ label: WEEKDAY_LABELS[w.dow], value: w.n }));
  const topUsers = (d.topUsers || []).map((u) => ({ label: u.k, value: u.n }));

  const cards = [
    statCard('PC 상태 분포', donutChart(statusData)),
    statCard('OS 분포', donutChart(osData)),
    statCard('VPN 사용', donutChart(vpnData)),
    statCard(`보안 에이전트 (수집 ${sec.reported || 0}대)`, sec.reported ? hbars(secBars) : emptyChart('보안도구 미수집')),
    statCard('요일별 활동', vbars(weekday, { color: '#0f9f6e' })),
    statCard('사용자별 활동 Top 10', hbars(topUsers)),
  ];
  document.getElementById('stats-grid').innerHTML = cards.join('');
}

(function initControls() {
  const logDate = document.getElementById('log-date');
  const awayDate = document.getElementById('away-date');
  logDate.value = todayStr();
  awayDate.value = todayStr();
  const statsFrom = document.getElementById('stats-from');
  const statsTo = document.getElementById('stats-to');
  statsTo.value = todayStr();
  statsFrom.value = shiftDate(todayStr(), -13);
  document.getElementById('stats-reload').addEventListener('click', loadStats);
  statsFrom.addEventListener('change', loadStats);
  statsTo.addEventListener('change', loadStats);
  logDate.addEventListener('change', () => { logPage = 1; loadLog(); });
  awayDate.addEventListener('change', loadAway);
  document.getElementById('log-user').addEventListener('change', () => { logPage = 1; loadLog(); });
  document.getElementById('machine-search').addEventListener('input', renderMachines);
  document.getElementById('machine-status').addEventListener('change', renderMachines);
  document.getElementById('directory-import').addEventListener('click', () => document.getElementById('directory-import-file').click());
  document.getElementById('directory-import-file').addEventListener('change', (event) => importDirectoryFile(event.target.files?.[0]));
  document.getElementById('directory-list').addEventListener('click', openDirectoryModal);
  document.getElementById('directory-close').addEventListener('click', () => document.getElementById('directory-modal').classList.add('hidden'));
  document.getElementById('directory-modal').addEventListener('click', (event) => {
    if (event.target.id === 'directory-modal') document.getElementById('directory-modal').classList.add('hidden');
  });
  document.getElementById('directory-rows').addEventListener('click', (event) => {
    if (event.target.classList.contains('directory-save')) saveDirectoryRow(event.target);
  });
  document.getElementById('log-pagination').addEventListener('click', (event) => {
    const page = Number(event.target.dataset.page);
    if (!Number.isFinite(page)) return;
    logPage = page;
    renderLogPage();
  });
  document.getElementById('modal-log-pagination').addEventListener('click', (event) => {
    const page = Number(event.target.dataset.modalPage);
    if (!Number.isFinite(page)) return;
    modalLogPage = page;
    renderModalLogPage();
  });
  document.getElementById('log-prev').addEventListener('click', () => { logDate.value = shiftDate(logDate.value || todayStr(), -1); logPage = 1; loadLog(); });
  document.getElementById('log-next').addEventListener('click', () => { logDate.value = shiftDate(logDate.value || todayStr(), 1); logPage = 1; loadLog(); });
  document.getElementById('away-prev').addEventListener('click', () => { awayDate.value = shiftDate(awayDate.value || todayStr(), -1); loadAway(); });
  document.getElementById('away-next').addEventListener('click', () => { awayDate.value = shiftDate(awayDate.value || todayStr(), 1); loadAway(); });
})();

load();
loadLog();
loadAway();
loadStats();
setInterval(load, 5000);
setInterval(loadLog, 10000);
setInterval(loadAway, 30000);
setInterval(loadStats, 60000);
