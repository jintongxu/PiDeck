---
title: PiDeck 正式版发布仅构建 Windows
type: tip
created: 2026-09-24T12:00:00.000Z
keywords:
  - PiDeck
  - 正式版
  - release
  - GitHub Release
  - Windows
  - electron-builder
  - dist:win
  - 7890
sourceRef: .github/workflows/release.yml; .github/workflows/build-windows.yml; scripts/dist-win.js; package.json
lifecycleStatus: active
---

# PiDeck 正式版发布仅构建 Windows

当发布负责人明确只需要 Windows 正式版时，构建和上传链路只处理 Windows，不要启动 macOS、Linux 或其它架构的构建任务。

当前约定：

- 正式版本号、`package.json` / `package-lock.json`、双语 CHANGELOG、GitHub tag 仍需保持一致；版本 tag 使用 `vX.Y.Z`。
- Windows 发布资产至少包括 NSIS 安装包、portable、ZIP、`latest.yml` 和 NSIS `.blockmap`。如果需要 DSH，额外上传 Windows 对应 runtime；需要 runner-node 时上传 Windows x64/arm64 资源。
- 本地 Windows 正式构建使用 `npm run dist:win`（或按需指定 `nsis`、`portable`、`zip`），产物位于 `release/`。网络访问使用本机 Clash 代理 `http://127.0.0.1:7890`。
- GitHub Actions 应使用 Windows-only 构建路径；不要无参数触发包含 macOS/Linux 矩阵的通用 `release.yml` 后再等待其它平台完成。若通用 workflow 已上传其它平台资产，应在确认后从该 Release 删除 macOS/Linux 安装包、update metadata 和 runtime。
- Windows 之外的平台资产不属于本次发布范围，不要为了凑完整矩阵而等待或补发它们；也不要创建独立的 DSH runtime Release tag。
- 上传完成后核对 GitHub Release 为正式版（非 draft、非 prerelease），并确认 Windows 安装包、`latest.yml`、`.blockmap` 的版本和文件名均为当前版本。

常见误区：GitHub Actions 远程 runner 不会经过本机 `127.0.0.1:7890`；7890 只对本地命令生效。Windows-only 需求下，远程多平台 workflow 仍可能因 macOS/Linux 任务或 sidecar 上传而拖慢或失败，不能把这些任务当作 Windows 发布失败。
