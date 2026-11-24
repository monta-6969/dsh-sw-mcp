# SOLIDWORKS 建模预设 —— 安装三步

1. **解压**到固定目录（例如 `D:\tools\sw-ptc`，建议路径无空格；`bridge/bin/SwBridge.exe` 与 interop DLL 已随包，不需要 .NET SDK）。
2. **装依赖**：`cd D:\tools\sw-ptc` 之后跑 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`。脚本会更新两个 MCP 服务的本机路径，并安装 npm 运行依赖。
3. **登记到 DSH profile 再重启**（预设不做热重载）：在 `C:\Users\<你>\.dsh\profiles\desktop\package.json` 的
   `dependencies` 里加 `"@local/dsh-sw-preset": "file:D:/tools/sw-ptc"`，在 `dsh.profile.bundles` 里加
   `@local/dsh-sw-preset`，然后**重启 DeepSeek Harness**。

重启后，SW 绘图走**原生单步工具**：一次工具调用只做一个动作，同类几何可以在一次调用里用数组批量给。
预设清单里只有一个 SW 模式：**「SW 建模（原生单步）」（id `sw-native`）**。旧的 `sw-ptc` 预设
（PTC 的 `run_code` 整段程序入口）及其执行器已**移除**，清单里不会再出现；仅保留一句历史：
它曾用整段程序做图，因单步可控性不足而作废（原因见 `docs\SW-自动化MCP-研究报告.md` 顶部横幅）。
图纸建模按 `skills/native-workflows/SKILL.md` 的配方调用当前原生工具面即可。

完整说明（环境要求、装完怎么确认、数据目录 `%LOCALAPPDATA%\sw-mcp\`、改源码）见
`docs\SW-自动化MCP-研究报告.md` 附录 B.11「构建、打包、安装」——该文档描述 PTC 时期，顶部有
DEPRECATED 说明，保留作历史记录；失败码速查见附录 B.10「失败码与错误处理表」，
现行排错见 `skills/sw-troubleshooting/SKILL.md`。卸载无专节，从 DSH profile 移除
`@local/dsh-sw-preset` 并重启即可。
