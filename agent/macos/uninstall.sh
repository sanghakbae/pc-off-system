#!/bin/bash
# macOS 에이전트 제거
set -euo pipefail
LABEL="com.pmon.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_DIR="$HOME/Library/Application Support/pmon-agent"
APP_DIR="$HOME/Applications/PC-OFF Agent.app"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$INSTALL_DIR"
rm -rf "$APP_DIR"
echo "✅ 에이전트 제거 완료."
