# Security Policy

## Supported Versions

当前只维护最新公开版本。

## Installer Safety Notice

当前 `0.1.0` 分支仅发布源码，尚未提供安装包或自动更新资产。

## Reporting a Vulnerability

如果你发现安全问题，请通过 GitHub Issues 或仓库作者主页联系作者。

请不要在公开 Issue 中直接贴出 Cookie、Token、账号信息、私密链接或可复现的敏感数据。

## Sensitive Data

Mineradio 不应收集或上传用户 Cookie。用户登录状态应保存在本地用户数据目录中，Navidrome 密码由 Electron 安全存储保护。

如果你要提交问题反馈，请先确认没有附带：

- `.cookie`
- `.qq-cookie`
- 本地音乐文件
- 用户账号截图
- 调试日志中的 Cookie、Token 或隐私路径
