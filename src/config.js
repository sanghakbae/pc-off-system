'use strict';
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT || '4500', 10),
  // 0.0.0.0 으로 바인딩해야 동일 네트워크의 다른 PC 에이전트가 접속 가능
  host: process.env.HOST || '0.0.0.0',
  publicBaseUrl: process.env.PMON_PUBLIC_BASE_URL || 'http://127.0.0.1:4501',
  installGoogleChatWebhookUrl: process.env.PMON_INSTALL_GOOGLE_CHAT_WEBHOOK_URL || '',
  // 에이전트와 공유하는 비밀 토큰. 운영 시 반드시 변경하세요.
  token: process.env.AGENT_TOKEN || 'change-me-pmon-token',
  // 하트비트 간격(초). 이 값의 2.5배 동안 보고가 없으면 오프라인으로 간주.
  heartbeatSec: parseInt(process.env.HEARTBEAT_SEC || '30', 10),

  // --- 자리 비움 분석 기준 ---
  // 점심시간은 자리 비움에서 제외 (근로기준법 제54조 휴게시간 = 자유 이용 보장)
  // 연속 이 시간(분) 이상 자리 비우면 '오래 비움'으로 표시
  awayLongMin: parseInt(process.env.AWAY_LONG_MIN || '60', 10),
  // 하루 이 횟수 이상 자리 비우면 '자주 비움'으로 표시
  awayFrequentCount: parseInt(process.env.AWAY_FREQUENT_COUNT || '10', 10),
  // 이 시간(초) 미만의 짧은 잠금은 '자리 비움' 횟수에서 제외
  awayMinCountSec: parseInt(process.env.AWAY_MIN_COUNT_SEC || '60', 10),
  // 점심시간 (로컬 시간, 24h). 요일별: 월~목 / 금 / 그 외(주말 등 null)
  lunch: {
    monThu: { start: [13, 0], end: [14, 0] },
    fri: { start: [12, 30], end: [14, 0] },
  },
  // 업무시간 (로컬 24h). 자리 비움은 이 구간 안에서만 집계, 출근/퇴근·지각 판단 기준.
  work: { start: [9, 0], end: [18, 0] },
};
