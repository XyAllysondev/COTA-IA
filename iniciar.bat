@echo off
cd /d "%~dp0"
start "CotaIA" http://localhost:3000
node server.js
