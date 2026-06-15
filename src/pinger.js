'use strict';
const { execFile } = require('child_process');
const { stmts, applyPing, config } = require('./db');

// 단일 IP 에 ICMP 핑 1회. 성공(도달 가능) 시 resolve(true), 실패 시 resolve(false).
// macOS/Linux 의 ping 은 일반 사용자 권한으로 동작합니다.
function pingOnce(ip) {
  return new Promise((resolve) => {
    // -c 1: 1회, -W/-t: 타임아웃. macOS 는 -t(초), Linux 는 -W(초)라 둘 다 무난한 값 사용.
    const args = process.platform === 'darwin'
      ? ['-c', '1', '-t', '2', ip]
      : ['-c', '1', '-W', '2', ip];
    execFile('ping', args, { timeout: 4000 }, (err) => {
      resolve(!err); // exit code 0 이면 도달 가능
    });
  });
}

// 모든 활성 대상을 동시에(과도하지 않게) 핑하고 결과를 DB 에 반영
async function sweep() {
  const targets = await stmts.enabledTargets.all();
  if (!targets.length) return;
  await Promise.all(targets.map(async (t) => {
    try {
      const reachable = await pingOnce(t.ip);
      const transition = await applyPing(t, reachable);
      if (transition) {
        console.log(`[ping] ${t.label || t.ip} (${t.ip}) → ${transition === 'power_on' ? '온라인 전환' : '오프라인 전환'}`);
      }
    } catch (e) {
      console.error(`[ping] ${t.ip} 오류:`, e.message);
    }
  }));
}

let timer = null;
function start() {
  const intervalMs = (parseInt(process.env.PING_SEC || '30', 10)) * 1000;
  sweep().catch(() => {});
  timer = setInterval(() => sweep().catch(() => {}), intervalMs);
  console.log(`핑 감시 시작: ${intervalMs / 1000}초 간격`);
}
function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, sweep, pingOnce };
