# 安装与换机器

## 这台机器上已具备的条件

| 项 | 值 |
| --- | --- |
| SOLIDWORKS | `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\SLDWORKS.exe`，版本 34.3.2.0003（2026 SP3.2） |
| 模板目录 | `C:\ProgramData\SOLIDWORKS\SOLIDWORKS 2026\templates\`（`gb_part.prtdot`、`gb_a3.drwdot` 等） |
| Node | `C:\Program Files\nodejs\node.exe` |

## 桥接器的 exe 必须放在工作区以外

实测 `D:\静静\临时文件` 的 ACL 含 `Everyone:(CI)(DENY)(DC)`，exe 放那儿 COM 绑定稳定失败
（`MK_E_UNAVAILABLE`）；搬到 `D:\静静\任务（干活的文件分类放这里）\sw-mcp\bridge\bin\` 后稳定成功。
换机器时先确认这一点，再怀疑代码。

## 验证装上了

新会话默认只有 8 个核心工具：`catalog`、`model`、`drawing`、`workspace`、`inspect`、`constraints`、`capture`、`deliver`。按需 11 组：`assembly`、`assembly_inspect`、`qa`、`workspace_ops`、`advanced_api`、`analysis`、`calculate`、`select`、`job`、`task`、`datum`；用 `catalog action="activate" capability="<组>"` 打开。第一条调用：

```
workspace action="preflight"
```

期望：拿到设计状态、实例状态与当前版本，必要时带上 SW 的 `capabilities`。
SOLIDWORKS 没开时应该报 `SW_NOT_RUNNING` —— 这仍然是**正常回答**，不是工具坏了。

## 环境要求

- SOLIDWORKS 必须**由用户先打开**。这个服务只连接，不启动、不关闭。
- `.lnk` 不能用来「复用/拉起」：SOLIDWORKS 开着时 `start` 会多起一个无窗口的 `SLDWORKS.exe`。
- 多实例由 broker 按 `designId` 分通道管理；不要自己再拉起一个 SOLIDWORKS 去「帮忙」。
- 工作流按 `skills/native-workflows/SKILL.md` 的 N1–N9 配方走；不要再用整段程序入口。
