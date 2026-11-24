#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 sw-mcp 打成一个能直接装进 DSH profile 的 zip。

    python tools/package.py                 # 输出到桌面 sw-ptc-<今天>.zip
    python tools/package.py --out D:/x.zip  # 指定路径
    python tools/package.py --list          # 只列会打进包的文件

规则：
- 只打运行与安装需要的东西；`node_modules`、`test/out`、日志、根目录的 `_*.mjs` 调试脚本一律不进包。
- `bridge/bin` 只带 exe 与两个 interop DLL（预编译，目标机不需要 .NET SDK）。
- 被 `cordis.patch.yml` 或 `package.json`（`exports` / `files`）点名的文件必须进包：漏一个，
  bundle 装到别的机器上会在装载 patch 时找不到模块。打包前这条和「INCLUDE_FILES 必须存在」
  一起硬校验（见 `problems()`），漏项直接报错，不再静默跳过。
- `test/.state` 这类目录是本机运行态（`sw-pids.json` 记着本机 PID），不进包。
- 打之前先跑一遍自检：包里的每个 .mjs 都要 `node --check` 通过，.ps1 必须是 UTF-8 带 BOM。
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
PATCH_PREFIX = "@local/dsh-sw-preset/"

INCLUDE_DIRS = ["server", "skills", "docs", "designs", "drawings", "tools", "bridge/src", "contracts", "samples"]
INCLUDE_FILES = [
    "cordis.patch.yml",
    "package.json",
    "package-lock.json",
    "INSTALL.md",
    "install.ps1",
    "restrict-tools.js",
    "bili-bypass.js",
    "prompt-surface.js",
    "experience-nudge.js",
    "experience-digest.js",
    "review-gate.js",
    "bridge/build.ps1",
]
BIN_FILES = ["SwBridge.exe", "SolidWorks.Interop.sldworks.dll", "SolidWorks.Interop.swconst.dll"]
SKIP_DIRS = {"node_modules", "out", "__pycache__", ".git", "logs", "images", "review", ".venv", "cache", "snapshots", ".state"}
SKIP_SUFFIX = (".log", ".pyc", ".zip", ".bak")
SKIP_NAMES = {"done", "status", "documents.json", "owner.json", "sw-pids.json"}
# 开发期构建脚本：bridge/src 随源码一起发，它也只用来在目标机重编。它不参与安装/运行
# 时的路径输出，历史版本没有 BOM 与 [Console]::OutputEncoding；BOM 规则只约束运行时
# 真正会执行的那几个 .ps1（server/*.ps1），这里显式豁免并留痕。
# TODO: 给 bridge/build.ps1 补 BOM 与 OutputEncoding 后，把本集合删掉。
DEV_PS1 = {"bridge/build.ps1"}


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def collect():
    """返回 (要打进包的文件, INCLUDE_FILES 里在仓库中不存在的名字)。

    缺文件不再静默跳过：由 main() 汇总成打包失败。
    """
    files = []
    missing = []
    for name in INCLUDE_FILES:
        full = os.path.join(ROOT, name)
        if os.path.isfile(full):
            files.append(full)
        else:
            missing.append(name)
    for name in INCLUDE_DIRS:
        base = os.path.join(ROOT, name)
        for current, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for entry in sorted(names):
                if entry.startswith("_") or entry in SKIP_NAMES:
                    continue
                if entry.endswith(SKIP_SUFFIX):
                    continue
                full = os.path.join(current, entry)
                if os.path.getsize(full) > 4 * 1024 * 1024:
                    continue  # 大图不进包
                files.append(full)
    for entry in BIN_FILES:
        full = os.path.join(ROOT, "bridge", "bin", entry)
        if os.path.isfile(full):
            files.append(full)
    # test/ 不带 test/out、不带 .state 这类运行态
    test_dir = os.path.join(ROOT, "test")
    for current, dirs, names in os.walk(test_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for entry in sorted(names):
            if entry.startswith("_") or entry in SKIP_NAMES or entry.endswith(SKIP_SUFFIX):
                continue
            full = os.path.join(current, entry)
            if os.path.getsize(full) > 1024 * 1024:
                continue
            files.append(full)
    seen, unique = set(), []
    for full in files:
        key = rel(full)
        if key not in seen:
            seen.add(key)
            unique.append(full)
    return sorted(unique, key=rel), missing


def referenced():
    """cordis.patch.yml 的 `@local/dsh-sw-preset/*` 与 package.json 的 exports/files 点名的路径。

    返回 (文件引用集合, 目录引用集合)。目录只要求包里有东西，文件要求逐条命中。
    """
    files, dirs = set(), set()
    patch = os.path.join(ROOT, "cordis.patch.yml")
    if os.path.isfile(patch):
        text = io.open(patch, encoding="utf-8").read()
        files.update(re.findall(re.escape(PATCH_PREFIX) + r"([^\s'\"#,]+)", text))
    manifest_path = os.path.join(ROOT, "package.json")
    if os.path.isfile(manifest_path):
        manifest = json.load(io.open(manifest_path, encoding="utf-8"))
        for target in (manifest.get("exports") or {}).values():
            if isinstance(target, str) and target.startswith("./"):
                files.add(target[2:])
        for name in manifest.get("files") or []:
            clean = name.rstrip("/")
            if clean in INCLUDE_DIRS or os.path.isdir(os.path.join(ROOT, clean)):
                dirs.add(clean)
            else:
                files.add(clean)
    return files, dirs


def problems(files, missing):
    """会阻断打包的规则问题：INCLUDE_FILES 缺文件、被引用的文件/目录没进包。"""
    found = []
    if missing:
        found.append("INCLUDE_FILES 里这些文件在仓库中不存在：" + "、".join(sorted(missing)))
    present = {rel(item) for item in files}
    refs, dirs = referenced()
    dangling = sorted(name for name in refs if name not in present)
    if dangling:
        found.append("被 cordis.patch.yml / package.json 引用、但没进包：" + "、".join(dangling))
    empty = sorted(name for name in dirs if not any(item.startswith(name + "/") for item in present))
    if empty:
        found.append("package.json files 声明的目录里一个文件都没进包：" + "、".join(empty))
    return found


def check(files):
    found = []
    for full in files:
        name = rel(full)
        if name.endswith(".mjs") or name.endswith(".js"):
            result = subprocess.run(["node", "--check", full], capture_output=True, text=True)
            if result.returncode != 0:
                found.append(f"{name}: node --check 失败\n{result.stderr.strip()[:400]}")
            data = io.open(full, "rb").read()
            if b"\r\n" in data:
                found.append(f"{name}: 含 CRLF（仓库统一 LF）")
        if name.endswith(".ps1") and name not in DEV_PS1:
            data = io.open(full, "rb").read()
            if not data.startswith(b"\xef\xbb\xbf"):
                found.append(f"{name}: PowerShell 脚本必须是 UTF-8 带 BOM")
            if b"[Console]::OutputEncoding" not in data:
                found.append(f"{name}: 缺少 [Console]::OutputEncoding（中文路径会乱码）")
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--skip-check", action="store_true")
    args = parser.parse_args()

    files, missing = collect()
    # 规则检查不看 --skip-check：--skip-check 只跳过语法/BOM 自检，包内容的完整性不允许跳过。
    rules = problems(files, missing)
    if args.list:
        for full in files:
            print(rel(full))
        print(f"\n{len(files)} 个文件")
        if rules:
            print("\n规则检查失败（正式打包会退出 1）：", file=sys.stderr)
            for item in rules:
                print(f"  - {item}", file=sys.stderr)
            return 1
        return 0

    if rules:
        print("打包前的规则检查失败，先修这些再打包：", file=sys.stderr)
        for item in rules:
            print(f"  - {item}", file=sys.stderr)
        return 1

    if not args.skip_check:
        found = check(files)
        if found:
            print("自检失败，先修这些再打包：", file=sys.stderr)
            for item in found:
                print(f"  - {item}", file=sys.stderr)
            return 1

    version = json.load(io.open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"]
    out = args.out or os.path.join(DESKTOP, f"sw-ptc-{__import__('datetime').date.today():%Y-%m-%d}.zip")
    out = os.path.abspath(out)
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for full in files:
            bundle.write(full, arcname=rel(full))
    size = os.path.getsize(out)
    with zipfile.ZipFile(out) as bundle:
        count = len(bundle.namelist())
    print(f"包版本 {version}：{out}")
    print(f"{count} 个条目，{size / 1048576:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
