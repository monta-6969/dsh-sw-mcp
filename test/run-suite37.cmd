@echo off
cd /d "D:\静静\任务（干活的文件分类放这里）\sw-mcp"
node test/suite.mjs > test\suite-37.log 2>&1
echo EXIT:%ERRORLEVEL% >> test\suite-37.log
