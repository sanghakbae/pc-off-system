'use strict';
// 자리 비움 분석 (잠금=자리 비움, 잠금해제=복귀). 에이전트 PC만 대상.
// ※ 법정 위반 판정이 아니라 사내 참고 통계. 점심시간(근로기준법 제54조 휴게)은 제외.
const { stmts } = require('./db');
const config = require('./config');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstParts(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    dow: d.getUTCDay(),
  };
}

function kstDayRange(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const now = new Date(Date.now() + KST_OFFSET_MS);
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) : now.getUTCMonth() + 1;
  const date = match ? Number(match[3]) : now.getUTCDate();
  if (!year || !month || !date) return null;
  const start = Date.UTC(year, month - 1, date) - KST_OFFSET_MS;
  return { start, end: start + 24 * 60 * 60 * 1000, date: `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}` };
}

function kstAt(dayStart, hm) {
  const p = kstParts(dayStart);
  return Date.UTC(p.year, p.month, p.date, hm[0], hm[1]) - KST_OFFSET_MS;
}

function parseHm(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback;
  return [h, m];
}

// 해당 날짜의 점심시간 [시작ms, 끝ms] 또는 null (주말 등), 한국 시간 기준
function lunchWindow(dayStart) {
  const { dow } = kstParts(dayStart); // 0=일 … 6=토
  let win = null;
  if (dow >= 1 && dow <= 4) win = config.lunch.monThu;
  else if (dow === 5) win = config.lunch.fri;
  if (!win) return null;
  return [kstAt(dayStart, win.start), kstAt(dayStart, win.end)];
}

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

// 해당 날짜의 업무시간 [시작ms, 끝ms], 한국 시간 기준
function workWindow(dayStart, machine) {
  const start = parseHm(machine?.work_start, config.work.start);
  const end = parseHm(machine?.work_end, config.work.end);
  return [kstAt(dayStart, start), kstAt(dayStart, end)];
}

// dateStr: 'YYYY-MM-DD' (없으면 오늘). now: 진행 중(미닫힌) 비움 계산용 현재시각.
async function computeAway(dateStr, now) {
  now = now || Date.now();
  const range = kstDayRange(dateStr);
  if (!range) return null;
  const { start, end } = range;
  const lunch = lunchWindow(start);
  const isToday = now >= start && now < end;
  const longMs = config.awayLongMin * 60 * 1000;

  const machineRows = await stmts.analysisMachines.all();
  const machines = await Promise.all(machineRows.map(async (m) => {
    const evs = (await stmts.eventsForMachine.all(m.id, start, end)).slice().sort((a, b) => a.ts - b.ts);
    const isPing = m.source === 'ping';
    const [W1, W2] = workWindow(start, m);

    // 자리 비움 짝짓기 기준
    //  - 에이전트: lock(자리뜸) → unlock(복귀)  · 정확
    //  - 핑:       shutdown(꺼짐) → power_on(켜짐) · 전원 기준(참고용)
    const startType = isPing ? 'shutdown' : 'lock';
    const endType = isPing ? 'power_on' : 'unlock';

    // 한국 시간 기준: 출근 = 그날 첫 PC 로그인(power_on), 퇴근 = 그날 마지막 PC 종료(shutdown).
    // 중간에 PC를 껐다 켜도 마지막 종료만 퇴근으로 본다.
    const offlineAfter = config.heartbeatSec * 2.5 * 1000;
    const liveNow = isToday && (now - m.last_seen <= offlineAfter); // 지금 켜져 근무중?

    const arrivalEv = evs.find((e) => e.type === 'power_on');
    const arrival = arrivalEv ? arrivalEv.ts : null;
    const lastShutdown = [...evs].reverse().find((e) => e.type === 'shutdown');
    // 퇴근 = 그날 마지막 종료(shutdown). 단 종료 보고가 없어도(급속종료·절전·네트워크 끊김 등)
    // 마지막 보고 후 3시간 넘게 오프라인이면(또는 지난 날이면) 그 마지막 보고시각을 퇴근으로 추정한다.
    const OFFLINE_DEPARTURE_MS = 3 * 60 * 60 * 1000;
    let departure = liveNow ? null : (lastShutdown ? lastShutdown.ts : null);
    // 자동 기록된 '종료(추정)' 이벤트가 퇴근으로 잡히면 추정으로 표시.
    let departureEstimated = !!(departure != null && lastShutdown && lastShutdown.estimated);
    // (자동기록 전 구간 보완) last_seen 은 하트비트 포함 마지막 보고시각. 그 보고가 이 날 안에 있을 때만 적용.
    const lastSeen = Number(m.last_seen);
    if (departure == null && !liveNow && Number.isFinite(lastSeen) && lastSeen >= start && lastSeen < end) {
      const goneFor = (isToday ? now : end) - lastSeen;
      if (!isToday || goneFor >= OFFLINE_DEPARTURE_MS) {
        departure = lastSeen;
        departureEstimated = true;
      }
    }
    const lateArrival = arrival != null && arrival > W1;

    // startType → 다음 endType 짝짓기
    const raw = [];
    let open = null;
    for (const e of evs) {
      if (e.type === startType) { if (open === null) open = e.ts; }
      else if (e.type === endType) { if (open !== null) { raw.push([open, e.ts]); open = null; } }
      else if (!isPing && e.type === 'power_on') { open = null; } // 에이전트: 재부팅 시 열린 잠금 리셋
    }
    // 에이전트가 아직 잠겨있고 오늘이면 '지금까지'(퇴근시각 상한) 비움으로 간주.
    // 핑은 열린 shutdown(=꺼진 채)이면 퇴근이므로 비움으로 세지 않음.
    if (!isPing && open !== null && isToday) raw.push([open, Math.min(now, W2)]);

    const periods = raw.map(([a, b]) => {
      // 업무시간 [W1,W2] 으로 자른 뒤 점심시간 제외
      const ws = Math.max(a, W1), we = Math.min(b, W2);
      if (we <= ws) return null;
      const rawMs = we - ws;
      const lo = lunch ? overlap(ws, we, lunch[0], lunch[1]) : 0;
      const eff = Math.max(0, rawMs - lo);
      return { start: ws, end: we, rawSec: Math.round(rawMs / 1000), effectiveSec: Math.round(eff / 1000) };
    }).filter((p) => p && p.rawSec >= config.awayMinCountSec && p.effectiveSec > 0);

    const totalAwaySec = periods.reduce((s, p) => s + p.effectiveSec, 0);
    const longestAwaySec = periods.reduce((mx, p) => Math.max(mx, p.effectiveSec), 0);

    // 근무(재실) 시간: 업무시간 내 출근~퇴근 구간에서 점심·자리비움을 뺀 시간
    let presentSec = 0;
    if (arrival != null) {
      const aStart = Math.max(arrival, W1);
      let aEnd;
      if (liveNow) aEnd = Math.min(now, W2);
      else if (departure != null) aEnd = Math.min(departure, W2);
      else aEnd = isToday ? Math.min(now, W2) : W2;
      if (aEnd > aStart) {
        const lunchInSpan = lunch ? overlap(aStart, aEnd, lunch[0], lunch[1]) : 0;
        presentSec = Math.max(0, Math.round((aEnd - aStart - lunchInSpan) / 1000) - totalAwaySec);
      }
    }

    return {
      id: m.id,
      hostname: m.hostname,
      username: m.username,
      source: m.source,
      workStart: m.work_start || '09:00',
      workEnd: m.work_end || '18:00',
      basis: isPing ? 'power' : 'lock', // power=전원기준(참고) · lock=잠금기준(정확)
      arrival,
      departure,
      departureEstimated,
      lateArrival,
      presentSec,
      awayCount: periods.length,
      totalAwaySec,
      longestAwaySec,
      longAway: periods.some((p) => p.effectiveSec * 1000 >= longMs),
      frequent: periods.length >= config.awayFrequentCount,
      periods,
    };
  }));

  return {
    date: range.date,
    start, end,
    lunch: lunch ? { start: lunch[0], end: lunch[1] } : null,
    workOptions: [
      { label: '9-18', start: '09:00', end: '18:00' },
      { label: '10-19', start: '10:00', end: '19:00' },
    ],
    thresholds: {
      longMin: config.awayLongMin,
      frequentCount: config.awayFrequentCount,
      minCountSec: config.awayMinCountSec,
    },
    machines,
  };
}

module.exports = { computeAway, lunchWindow };
