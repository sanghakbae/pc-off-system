#!/bin/bash
# macOS 에이전트 설치 — 브랜드 앱 번들을 만든 뒤 LaunchAgent 로 등록
#
# 사용법:
#   PMON_SERVER="http://127.0.0.1:4501" PMON_TOKEN="실제토큰" ./install.sh
#
# 잠금/잠금해제는 로그인 GUI 세션 정보(ioreg)로 판단하므로 LaunchDaemon(루트)이 아닌
# LaunchAgent(사용자 세션)로 설치합니다. 별도 개인정보 권한(TCC)·관리자 권한 불필요.

set -euo pipefail

SERVER="${PMON_SERVER:-http://127.0.0.1:4501}"
TOKEN="${PMON_TOKEN:-change-me-pmon-token}"
INTERVAL="${PMON_INTERVAL:-30}"

LABEL="com.pmon.agent"
INSTALL_DIR="$HOME/Library/Application Support/pmon-agent"
APP_DIR="$HOME/Applications/PC-OFF Agent.app"
APP_CONTENTS="$APP_DIR/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_SRC="$SCRIPT_DIR/pmon-agent.sh"
ICON_SRC="$SCRIPT_DIR/pc-off-app-icon.svg"

echo "▶ 서버: $SERVER"
echo "▶ 설치 위치: $INSTALL_DIR"
echo "▶ 앱 번들: $APP_DIR"

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents" "$APP_MACOS" "$APP_RESOURCES"
cp "$SCRIPT_SRC" "$APP_RESOURCES/pmon-agent.sh"
chmod +x "$APP_RESOURCES/pmon-agent.sh"

if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_RESOURCES/pc-off-app-icon.svg"
else
  curl -fsSL "$SERVER/download/macos/pc-off-app-icon.svg" -o "$APP_RESOURCES/pc-off-app-icon.svg" 2>/dev/null || true
fi

if [ -f "$APP_RESOURCES/pc-off-app-icon.svg" ] && command -v qlmanage >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  TMP_ICON_ROOT="$(mktemp -d)"
  ICONSET="$TMP_ICON_ROOT/pc-off-app-icon.iconset"
  mkdir -p "$ICONSET"
  for SIZE in 16 32 128 256 512; do
    SCALE_SIZE=$((SIZE * 2))
    OUT_DIR="$TMP_ICON_ROOT/render-$SCALE_SIZE"
    mkdir -p "$OUT_DIR"
    qlmanage -t -s "$SCALE_SIZE" -o "$OUT_DIR" "$APP_RESOURCES/pc-off-app-icon.svg" >/dev/null 2>&1 || true
    RENDERED="$(find "$OUT_DIR" -name '*.png' -print -quit)"
    if [ -f "$RENDERED" ]; then
      cp "$RENDERED" "$ICONSET/icon_${SIZE}x${SIZE}@2x.png"
      if [ "$SIZE" -ne 16 ]; then cp "$RENDERED" "$ICONSET/icon_${SCALE_SIZE}x${SCALE_SIZE}.png"; fi
    fi
  done
  iconutil -c icns "$ICONSET" -o "$APP_RESOURCES/pc-off-app-icon.icns" >/dev/null 2>&1 || true
  rm -rf "$TMP_ICON_ROOT"
fi

cat > "$APP_MACOS/PCOFFAgent" <<'RUNNER_EOF'
#!/bin/bash
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec /bin/bash "$APP_DIR/Resources/pmon-agent.sh"
RUNNER_EOF
chmod +x "$APP_MACOS/PCOFFAgent"

cat > "$APP_CONTENTS/Info.plist" <<'INFO_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>PC-OFF Agent</string>
  <key>CFBundleExecutable</key><string>PCOFFAgent</string>
  <key>CFBundleIdentifier</key><string>com.pcoff.agent</string>
  <key>CFBundleIconFile</key><string>pc-off-app-icon</string>
  <key>CFBundleName</key><string>PC-OFF Agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
INFO_EOF

ln -sf "$APP_RESOURCES/pmon-agent.sh" "$INSTALL_DIR/pmon-agent.sh"
# 브라우저로 받은 파일의 Gatekeeper 격리 속성 제거 (curl 다운로드는 없음)
/usr/bin/xattr -dr com.apple.quarantine "$APP_DIR" "$INSTALL_DIR/pmon-agent.sh" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_MACOS/PCOFFAgent</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PMON_SERVER</key><string>$SERVER</string>
    <key>PMON_TOKEN</key><string>$TOKEN</string>
    <key>PMON_INTERVAL</key><string>$INTERVAL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$INSTALL_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/agent.err</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "✅ 설치 완료. 상태: launchctl print gui/$(id -u)/$LABEL | head"
echo "   로그: tail -f \"$INSTALL_DIR/agent.log\""
echo "   제거: ./uninstall.sh"
