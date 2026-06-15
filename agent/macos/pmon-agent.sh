#!/bin/bash
# PC 모니터링 macOS 에이전트 (순수 셸 — Swift/컴파일/툴체인 불필요, 어느 Mac에서나 동작)
#
# 잠금 상태는 ioreg 의 IOConsoleLocked 를 폴링해 감지합니다(잠금/해제 시각에 폴링 간격만큼 오차).
# 보고 형식은 다른 에이전트와 동일: POST /api/report
#
# 환경변수: PMON_SERVER, PMON_TOKEN, PMON_INTERVAL(하트비트 초), PMON_POLL(잠금 폴링 초)

SERVER="${PMON_SERVER:-http://127.0.0.1:4501}"
TOKEN="${PMON_TOKEN:-change-me-pmon-token}"
INTERVAL="${PMON_INTERVAL:-30}"
POLL="${PMON_POLL:-3}"
PMON_AGENT_VERSION=2026061002
AUTO_UPDATE="${PMON_AUTO_UPDATE:-1}"
UPDATE_INTERVAL="${PMON_UPDATE_INTERVAL:-3600}"
SELF_PATH="$0"
LAST_UPDATE_CHECK=0

HOSTNAME_="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
USER_="$(whoami)"
OS_="macOS $(sw_vers -productVersion 2>/dev/null)"
IFACE="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
[ -z "$IFACE" ] && IFACE="en0"
MAC_="$(ifconfig "$IFACE" ether 2>/dev/null | awk '/ether/{print $2}')"
LANIP_="$(ipconfig getifaddr "$IFACE" 2>/dev/null)"
BOOT_SEC="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9][0-9]*\).*/\1/p')"
[ -z "$BOOT_SEC" ] && BOOT_SEC="$(date +%s)"
BOOT_MS=$(( BOOT_SEC * 1000 ))

now_ms() { echo $(( $(date +%s) * 1000 )); }

has_app() { [ -d "$1" ]; }
is_running() { pgrep -if "$1" >/dev/null 2>&1; }

security_tools_json() {
  if has_app "/Applications/AhnLab V3 for Mac.app" || [ -d "/Library/Application Support/ahnlab/v3mac" ]; then v3_installed=true; else v3_installed=false; fi
  if is_running "ahnlab/v3mac|com\\.ahnlab|v3svc|v3tray|v3fwd"; then v3_running=true; else v3_running=false; fi
  if has_app "/Applications/OfficeKeeper.app"; then ok_installed=true; else ok_installed=false; fi
  if is_running "OfficeKeeper|jkokmaind|jkokwatchd|jkokpolicyd|jkoklogd|com\\.jiran"; then ok_running=true; else ok_running=false; fi
  printf '{"v3":{"installed":%s,"running":%s},"officekeeper":{"installed":%s,"running":%s}}' "$v3_installed" "$v3_running" "$ok_installed" "$ok_running"
}

is_locked() {
  # "IOConsoleLocked" = Yes  (잠금) / No (해제)
  [ "$(ioreg -n Root -d1 2>/dev/null | awk -F' = ' '/IOConsoleLocked/{gsub(/ /,"",$2);print $2}')" = "Yes" ]
}

self_update() {
  [ "$AUTO_UPDATE" = "1" ] || return 0
  [ -w "$SELF_PATH" ] || return 0
  nowsec="$(date +%s)"
  [ $(( nowsec - LAST_UPDATE_CHECK )) -ge "$UPDATE_INTERVAL" ] || return 0
  LAST_UPDATE_CHECK="$nowsec"
  tmp="${TMPDIR:-/tmp}/pmon-agent-update.$$"
  if curl -fsS -m 15 "$SERVER/download/macos/pmon-agent.sh" -o "$tmp" 2>/dev/null; then
    remote_version="$(awk -F= '/^PMON_AGENT_VERSION=/{print $2; exit}' "$tmp" | tr -cd '0-9')"
    if [ -s "$tmp" ] && [ -n "$remote_version" ] && [ "$remote_version" -gt "$PMON_AGENT_VERSION" ] && ! cmp -s "$tmp" "$SELF_PATH"; then
      chmod +x "$tmp"
      mv "$tmp" "$SELF_PATH"
      echo "agent self-update applied"
      exec /bin/bash "$SELF_PATH"
    fi
  fi
  rm -f "$tmp"
}

vpn_interface() {
  route -n get 192.168.52.1 2>/dev/null | awk '/interface:/{print $2; exit}'
}

vpn_ip() {
  ip="$(ifconfig 2>/dev/null | awk '$1=="inet" && $2 ~ /^192[.]168[.]52[.]([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/ {print $2; exit}')"
  [ -n "$ip" ] && { echo "$ip"; return; }
  # 폴백: 실제 VPN 터널 인터페이스이고 그 IP가 VPN 대역일 때만 인정.
  # (LAN 머신에서도 route get 192.168.52.1 은 기본 인터페이스를 반환하므로 그대로 쓰면 LAN IP가 잡힌다)
  iface="$(vpn_interface)"
  case "$iface" in
    utun*|ppp*|ipsec*)
      vip="$(ipconfig getifaddr "$iface" 2>/dev/null)"
      case "$vip" in 192.168.52.*) echo "$vip" ;; esac
      ;;
  esac
}

vpn_connected() {
  [ -n "$(vpn_ip)" ] && return 0
  iface="$(vpn_interface)"
  case "$iface" in
    utun*|ppp*|ipsec*) return 0 ;;
    *) return 1 ;;
  esac
}

send() { # $1=type  $2=ts(선택)
  ts="$2"; [ -z "$ts" ] && ts="$(now_ms)"
  security_tools="$(security_tools_json)"
  VPNIP_="$(vpn_ip)"
  if vpn_connected; then vpn_connected_value=true; else vpn_connected_value=false; fi
  body="{\"hostname\":\"$HOSTNAME_\",\"username\":\"$USER_\",\"os\":\"$OS_\",\"mac\":\"$MAC_\",\"local_ip\":\"$LANIP_\",\"vpn_connected\":$vpn_connected_value,\"vpn_ip\":\"$VPNIP_\",\"boot_time\":$BOOT_MS,\"security_tools\":$security_tools,\"type\":\"$1\",\"ts\":$ts,\"token\":\"$TOKEN\"}"
  response="$(curl -fsS -m 10 -X POST "$SERVER/api/report" -H 'Content-Type: application/json' -H "X-Agent-Token: $TOKEN" -d "$body" 2>/dev/null)"
  if [ $? -eq 0 ]; then
    if printf '%s' "$response" | grep -q '"disabled"[[:space:]]*:[[:space:]]*true'; then
      echo "report disabled: 수집 중지"
      exit 0
    fi
    echo "report ok: $1"
  else
    echo "report 실패: $1"
  fi
}

cleanup() { send shutdown; exit 0; }
trap cleanup TERM INT

echo "pmon-agent(shell) 시작: host=$HOSTNAME_ user=$USER_ server=$SERVER iface=$IFACE mac=$MAC_ ip=$LANIP_"
self_update
send power_on

if is_locked; then last_locked=1; else last_locked=0; fi
if [ "$last_locked" = "1" ]; then send lock; fi
last_hb="$(date +%s)"

while true; do
  sleep "$POLL"
  if is_locked; then cur=1; else cur=0; fi
  if [ "$cur" != "$last_locked" ]; then
    if [ "$cur" = "1" ]; then send lock; else send unlock; fi
    last_locked="$cur"
  fi
  nowsec="$(date +%s)"
  if [ $(( nowsec - last_hb )) -ge "$INTERVAL" ]; then
    self_update
    send heartbeat
    last_hb="$nowsec"
  fi
done
