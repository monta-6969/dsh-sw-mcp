# sw-mcp 契约 v4

契约的唯一事实源是 `contracts/enums.json` + `server/contracts.mjs`；`contracts/schema/*.json` 与
`bridge/src/Contracts.Generated.cs` 都是生成物（UTF-8 无 BOM），不要手改。

```powershell
node tools/gen-contracts.mjs     # 生成 schema 与 Contracts.Generated.cs（bridge/build.ps1 编译前自动跑）
node tools/check-contracts.mjs   # 只比较；过期退出码 1
node test/contracts.mjs          # 契约单测（不需要 SOLIDWORKS）
```

现有 **41 个 op** 的名称与语义不变，新增 op 只追加。契约对象（引用/作业/任务图/曲线/快照/事件/经验/能力表/差异）与 op 分派见 `docs\SW-自动化MCP-研究报告.md` 附录 B.1「仓库地图」与 B.3「十一个工具、四十一个 op 与分派」。
