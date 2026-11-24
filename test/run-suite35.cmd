@echo off
cd /d "D:\静静\任务（干活的文件分类放这里）\sw-mcp"
node test/suite.mjs deliver-gate.mjs kinds.mjs curves.mjs gear.mjs gear-native.mjs pattern.mjs objects.mjs drawing-schema.mjs evidence-schema.mjs noop-guard.mjs unmeasured.mjs cut-semantics.mjs check-status.mjs concurrency.mjs bugfix-live.mjs compare.mjs drawings.mjs analysis.mjs snapshot-live.mjs broker-live.mjs plugin-digest.mjs > test\suite-35.log 2>&1
echo EXIT:%ERRORLEVEL% >> test\suite-35.log
