'use strict';
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseDateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    date = new Date(n < 100000000000 ? n * 1000 : n);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}
function tm(value) {
  const date = parseDateValue(value);
  return date ? date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
}
function tmf(value) {
  const date = parseDateValue(value);
  return date ? date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
}
function dur(s) { if (!s) return '0분'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}시간 ${m}분` : `${m}분`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const TYPE_LABEL = { login: '로그인', unlock: '잠금해제', lock: '잠금', shutdown: '종료', short_work: '단시간사용', absent: '결근' };
const dates = () => ({ from: document.getElementById('from').value, to: document.getElementById('to').value });

// 1) 기간 감사 + 요약 통계
async function loadReport() {
  const { from, to } = dates();
  document.getElementById('csv').href = `/api/report.csv?from=${from}&to=${to}`;
  const box = document.getElementById('content');
  box.innerHTML = '<p class="empty">불러오는 중…</p>';
  let d; try { d = await (await fetch(`/api/report?from=${from}&to=${to}`)).json(); } catch (e) { box.innerHTML = '<p class="empty">실패</p>'; return; }
  if (!d.ok) { box.innerHTML = `<p class="empty">${esc(d.error || '오류')}</p>`; return; }

  document.getElementById('note').textContent = `${d.from} ~ ${d.to} · ${d.days}일 · 잠금 이벤트는 에이전트 기준, 전원 이벤트는 핑 기준`;

  const s = d.summary;
  document.getElementById('cards').innerHTML = [
    ['대상 PC', `${s.machineCount}대`], ['기록 일수', `${s.recordDays}일`],
    ['총 사용시간', dur(s.totalPresentSec)], ['평균 사용/일', dur(s.avgPresentSec)], ['지각 합계', `${s.lateDays}회`],
  ].map(([k, v]) => `<div class="card"><div class="card-v">${v}</div><div class="card-k">${k}</div></div>`).join('');

  // PC 필터 드롭다운 채우기
  const sel = document.getElementById('f-machine');
  sel.innerHTML = '<option value="">전체 PC</option>' + d.machines.map((m) => `<option value="${esc(m.hostname)}">${esc(m.hostname)}</option>`).join('');

  if (!d.machines.length) { box.innerHTML = '<p class="empty">해당 기간에 활동 기록이 없습니다.</p>'; return; }
  box.innerHTML = d.machines.map((m) => {
    const rows = m.days.map((x) => `
      <tr class="${x.lateArrival || x.longAway || x.frequent ? 'flagged' : ''}">
        <td class="mono">${x.date}</td>
        <td class="mono ${x.lateArrival ? 'late' : ''}">${tm(x.arrival)}${x.lateArrival ? ' <span class="flag flag-late">지각</span>' : ''}</td>
        <td class="mono">${x.departure ? tm(x.departure) + (x.departureEstimated ? ' <span class="muted">(추정)</span>' : '') : '<span class="muted">근무중</span>'}</td>
        <td class="mono">${dur(x.presentSec)}</td>
        <td class="mono">${x.awayCount}회 / ${dur(x.totalAwaySec)}</td>
      </tr>`).join('');
    return `<div class="rpt">
      <div class="rpt-head">
        <a href="#" class="pc-link" data-host="${esc(m.hostname)}"><b>${esc(m.hostname)}</b></a>
        <span class="src src-${m.source}">${m.basis === 'power' ? '전원(핑)' : '잠금(에이전트)'}</span>
        <span class="muted">사용합계 ${dur(m.totals.presentSec)} · 평균 ${dur(m.totals.avgPresentSec)}/일 · 지각 ${m.totals.lateDays}일(${m.totals.lateRate}%) · 자리비움 ${m.totals.awayCount}회</span>
      </div>
      <table><thead><tr><th>날짜</th><th>출근</th><th>퇴근</th><th>사용시간</th><th>자리비움</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

  // 3) PC 상세: PC 이름 클릭 → 검색 필터에 넣고 검색
  box.querySelectorAll('.pc-link').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.getElementById('f-machine').value = a.dataset.host;
    document.getElementById('f-type').value = '';
    loadSearch();
    document.getElementById('search-result').scrollIntoView({ behavior: 'smooth' });
  }));
}

// 2) 이상 징후
async function loadAnomalies() {
  const { from, to } = dates();
  const box = document.getElementById('anomalies');
  box.innerHTML = '<p class="empty">불러오는 중…</p>';
  let d; try { d = await (await fetch(`/api/anomalies?from=${from}&to=${to}`)).json(); } catch (e) { box.innerHTML = '<p class="empty">실패</p>'; return; }
  if (!d.anomalies.length) { box.innerHTML = '<p class="empty">이상 징후 없음 ✅</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>시각</th><th>PC</th><th>유형</th><th>내용</th></tr></thead><tbody>${
    d.anomalies.map((a) => `<tr class="flagged">
      <td class="mono">${a.date && a.type === 'absent' ? a.date : tmf(a.ts)}</td>
      <td class="host">${esc(a.hostname)}</td>
      <td><span class="flag flag-long">${a.reasons.join(', ')}</span></td>
      <td class="muted">${TYPE_LABEL[a.type] || a.type}${a.presentSec != null ? ' · 사용 ' + dur(a.presentSec) : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

// 4) 검색/필터
async function loadSearch() {
  const { from, to } = dates();
  const machine = document.getElementById('f-machine').value;
  const type = document.getElementById('f-type').value;
  const qs = `from=${from}&to=${to}&machine=${encodeURIComponent(machine)}&type=${encodeURIComponent(type)}`;
  document.getElementById('search-csv').href = `/api/events/search.csv?${qs}`;
  const box = document.getElementById('search-result');
  box.innerHTML = '<p class="empty">불러오는 중…</p>';
  let d; try { d = await (await fetch(`/api/events/search?${qs}`)).json(); } catch (e) { box.innerHTML = '<p class="empty">실패</p>'; return; }
  if (!d.events.length) { box.innerHTML = '<p class="empty">결과 없음</p>'; return; }
  box.innerHTML = `<p class="muted" style="margin:4px 0 10px">${d.count}건${machine ? ' · ' + esc(machine) : ''}</p>
    <table><thead><tr><th>시각</th><th>PC</th><th>방식</th><th>이벤트</th></tr></thead><tbody>${
    d.events.map((e) => `<tr><td class="mono">${tmf(e.ts)}</td><td class="host">${esc(e.hostname)}</td>
      <td><span class="src src-${e.source}">${e.source === 'ping' ? '핑' : '에이전트'}</span></td>
      <td><span class="badge ${e.type}">${TYPE_LABEL[e.type] || e.type}</span></td></tr>`).join('')}</tbody></table>`;
}

// 5) 사각지대 점검
function agoTxt(s) { if (s < 3600) return `${Math.floor(s / 60)}분`; if (s < 86400) return `${Math.floor(s / 3600)}시간`; return `${Math.floor(s / 86400)}일`; }
async function loadCoverage() {
  const { from, to } = dates();
  const hours = document.getElementById('cov-hours').value;
  const box = document.getElementById('coverage');
  box.innerHTML = '<p class="empty">불러오는 중…</p>';
  let d; try { d = await (await fetch(`/api/coverage?hours=${hours}&from=${from}&to=${to}`)).json(); } catch (e) { box.innerHTML = '<p class="empty">실패</p>'; return; }
  if (!d.blind.length) { box.innerHTML = `<p class="empty">전체 ${d.total}대 모두 정상 보고 중</p>`; return; }
  box.innerHTML = `<p class="muted" style="margin:4px 0 10px">전체 ${d.total}대 중 <b style="color:var(--red)">${d.blindCount}대</b> 사각지대</p>
    <table><thead><tr><th>PC</th><th>방식</th><th>유형</th><th>마지막 보고</th><th>IP</th><th>MAC</th></tr></thead><tbody>${
    d.blind.map((m) => `<tr class="flagged">
      <td class="host">${esc(m.hostname)}</td>
      <td><span class="src src-${m.source}">${m.source === 'ping' ? '핑' : '에이전트'}</span></td>
      <td><span class="flag flag-long">${esc(m.kind)}</span></td>
      <td class="mono">${agoTxt(m.ageSec)} 전</td>
      <td class="mono muted">${esc(m.ip || '—')}</td>
      <td class="mono muted">${esc(m.mac || '—')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function loadAll() {
  await loadReport();
  await Promise.all([loadAnomalies(), loadCoverage(), loadSearch()]);
}

(function init() {
  const today = new Date();
  document.getElementById('to').value = ymd(today);
  document.getElementById('from').value = ymd(new Date(today.getTime() - 6 * 86400000));
  document.getElementById('load').addEventListener('click', loadAll);
  document.getElementById('f-machine').addEventListener('change', loadSearch);
  document.getElementById('f-type').addEventListener('change', loadSearch);
  document.getElementById('cov-hours').addEventListener('change', loadCoverage);
  loadAll();
})();
