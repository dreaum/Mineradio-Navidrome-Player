# Navidrome Branch Handoff

更新时间：2026-08-27

## 当前状态

- 工作区：`F:\code\Codex\Mineradio Navidrome Player`
- 分支：`main`
- 版本：`0.1.0`
- 发布仓库：`https://github.com/dreaum/Mineradio-Navidrome-Player`
- 上游基准：`https://github.com/XxHuberrr/Mineradio`

## 开始工作前

```powershell
git status --short --branch
git log --oneline -5 --decorate
Get-Content AGENTS.md -Encoding UTF8
Get-Content docs\UPSTREAM_COMPARISON.md -Encoding UTF8
```

涉及视觉基线或发布时，再阅读对应的 `docs/3D_PLAYLIST_SHELF_MEMORY.md`、
`docs/GLASS_SVG_TEXTURE.md`、`RELEASE.md` 和 `package.json`。

不要读取、提交或复制 `userdata/`、`.diag-userdata-*` 及其他本地缓存；它们
可能包含账号会话或加密凭据。
