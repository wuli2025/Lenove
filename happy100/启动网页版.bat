@echo off
chcp 65001 >nul
title 幸福小事 · 本地服务器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   这台电脑上没有找到 Node.js。
  echo   两个办法：
  echo     1) 直接双击 www\index.html 也能在电脑上用（只是手机连不上）
  echo     2) 去 https://nodejs.org 装一个 Node.js，再回来双击本文件
  echo.
  pause
  exit /b
)

node serve.mjs
pause
