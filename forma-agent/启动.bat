@echo off
chcp 65001 >nul
title FORMA Agent
cd /d "%~dp0src-tauri"

if exist "target\release\forma-agent.exe" (
  start "" "target\release\forma-agent.exe"
  exit /b
)
if exist "target\debug\forma-agent.exe" (
  start "" "target\debug\forma-agent.exe"
  exit /b
)

echo 还没有构建过，正在编译（首次约需几分钟）...
cargo run --release
