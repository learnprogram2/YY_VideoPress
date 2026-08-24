# 小燕压缩 · XY_VideoPress

> 压缩、转换视频，让硬盘更清爽。

## 目的

一个简单的桌面视频工具:拖入视频,选清晰度和码率,压缩或转格式,让文件更小、硬盘更健康。底层用 ffmpeg,界面用 Wails(Go + React)。

## 运行

```bash
wails3 dev      # 开发模式(热重载)
wails3 build    # 打包成 .app
```
需要本机装了 ffmpeg(`brew install ffmpeg`)。

## 文件结构

| 文件/目录 | 作用 |
| --- | --- |
| `main.go` | 应用入口:创建窗口、注册后端服务 |
| `videoservice.go` | 后端核心:探测视频、压缩(两遍编码)、转格式,全调 ffmpeg |
| `frontend/src/App.tsx` | 界面:选项、进度、结果、中英切换 |
| `frontend/src/App.css` | 界面样式(浅色) |
| `frontend/bindings/` | wails 自动生成的前后端绑定(勿手改) |
| `Taskfile.yml` / `build/` | wails 构建配置 |
