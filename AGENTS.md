# Mineradio Navidrome Project Rules

## Repository

- 可写源码仓库：`F:\code\Codex\Mineradio Navidrome Player`
- 发布目标：`https://github.com/dreaum/Mineradio-Navidrome-Player.git` 的 `main` 分支
- 上游基准：`https://github.com/XxHuberrr/Mineradio.git`
- 当前包版本：`0.1.0`

## Scope

这是 Windows Electron 音乐播放器的 Navidrome 分支。核心能力包括 Navidrome 服务器连接、媒体播放、歌词、粒子视觉、3D 歌单架、桌面歌词、迷你播放器和本地曲库。

- 不要将服务器密码、Cookie、用户数据、诊断目录、构建产物或本地缓存提交到 Git。
- 任何 Navidrome 密码必须保留在 Electron 安全存储路径，禁止写入前端持久化状态、日志或源码。
- 除非用户明确要求，不要修改既有视觉布局、玻璃质感、电影视觉或交互入口。

## Verification

代码或文档变更后至少执行：

```powershell
npm test
node --check server.js
node --check desktop/main.js
node --check public/app.js
git diff --check
```

旧 Mineradio 分支的详细规则和历史约束见 [docs/archive/MINERADIO_PROJECT_RULES_PRE_NAVIDROME.md](./docs/archive/MINERADIO_PROJECT_RULES_PRE_NAVIDROME.md)；其中旧仓库、旧版本和旧发布流程不能作为本分支现状。
