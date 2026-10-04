#!/usr/bin/env bash
# Stops processes started by `npm run dev` or `npm start` (API, simulator, Vite, orchestrator).
for pid in $(ps -eo pid=,comm=,args= | awk '$2=="node" && ($0 ~ /scripts\/(dev|start)\.mjs|apps\/server\/src\/main\.ts|simulator\/src\/cli\.ts|vite\/bin\/vite\.js|dist\/main\.js|dist\/cli\.js/) {print $1}'); do
  kill "$pid" 2>/dev/null
done
