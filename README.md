# Mineradio Navidrome Player

Mineradio Navidrome Player 是基于 Mineradio 的 Windows Electron 音乐播放器分支。它保留沉浸式歌词舞台、粒子视觉、3D 歌单架、迷你播放器和桌面模式，并增加了面向个人 Navidrome 服务的音乐库浏览、搜索、歌单和播放能力。

当前主分支：[`main`](https://github.com/dreaum/Mineradio-Navidrome-Player/tree/main)

## 当前状态

- 源码版本：`0.1.0`
- 当前仓库只提供源码，尚未随本次同步发布 Windows 安装包或 GitHub Release。
- Navidrome 连接使用 OpenSubsonic / Subsonic 兼容接口；请使用自己的服务地址和账号。

## 主要功能

- Navidrome 多服务器配置、切换与连接验证
- 专辑、艺术家、歌单、搜索、收藏和歌词读取
- 通过本机代理播放、封面和歌词请求，支持质量选择
- Windows 凭据保护：密码不会写入仓库或前端持久化状态
- 自动缓存：Navidrome 元数据、歌词、封面与网络/音频分片按服务器和资源复用；封面资源有大小上限和访问时间淘汰，缓存目录可查看和切换
- 本地曲库缓存与预载：歌词、封面、节奏分析和媒体地址支持按需加载、预载、取消和过期回收
- 前台占用控制：可设置前台帧率档位；窗口隐藏或空闲时降低渲染工作，后台才执行应用内存压缩和可选的 Windows 系统内存释放
- 生命周期回收：关闭桌面歌词、壁纸覆盖层或迷你播放器时释放歌词、封面、节奏图和对象 URL 引用
- 大文件友好：本地音频使用授权的分段读取和元数据内存边界，覆盖 MP3、FLAC、M4A 等格式
- 音频焦点保护：检测到其他 Windows 媒体会话播放时可自动暂停，冲突消失后恢复
- 歌词舞台、粒子视觉、3D 歌单架、DIY 视觉控制台、桌面歌词和迷你播放器
- 本地曲库导入，以及 MP3 / FLAC / M4A / WAV / OGG 播放

## 开发运行

要求：Windows、Node.js 与 npm。

```bash
npm install
npm start
```

运行 Navidrome 回归测试：

```bash
npm test
```

构建 Windows 安装包：

```bash
npm run build:win
```

构建产物会输出到 `dist/`。构建成功不等同于已发布，请不要把未签名的本地构建当作正式发行版传播。

## 连接 Navidrome

启动应用后，在账户/服务器配置中填写：

1. Navidrome 的完整服务地址，优先使用 `https://`。
2. 你的用户名与密码。
3. 使用 `http://` 时需在界面中明确确认非加密连接。

服务器的公开配置和凭据分别保存于当前 Windows 用户的数据目录；凭据由 Electron 的安全存储能力加密。详见 [PRIVACY.md](./PRIVACY.md)。

## 项目来源与许可

该分支源自 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)，并按 GPL-3.0-only 继续发布。第三方组件和服务的说明见 [NOTICE.md](./NOTICE.md)。

Navidrome 是独立项目；本项目不隶属于 Navidrome，也不提供音乐内容、账号或服务器托管服务。
