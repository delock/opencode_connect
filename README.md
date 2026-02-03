# Opencode-Slack连接插件安装配置文档

[English Version](README_en.md)

## 演示视频

![opencode_connect_demo](https://github.com/delock/opencode_connect/raw/master/images/opencode_connect_demo.gif)

## 概述

本文档介绍如何安装和配置Opencode-Slack连接插件，实现通过Slack控制Opencode的工作流程。

## 安装步骤

### 1. 克隆项目

首先从GitHub仓库克隆项目：

```
git clone https://github.com/delock/opencode_connect
```

### 2. 安装依赖包

修改 ~/.config/opencode/package.json 或者 ~/.opencode/package.json 文件，添加以下依赖：

```json
{
  "dependencies": {
    "@slack/socket-mode": "^2.0.5",
    "@slack/web-api": "^7.13.0"
  }
}
```

修改后第一次启动opencode时，opencode会自动安装这些依赖包。

### 3. 复制插件文件

将 `opencode-connect.ts` 文件复制到以下目录之一：

```
~/.config/opencode/plugins/
```

或

```
~/.opencode/plugins/
```

## Slack应用配置

### 1. 创建Slack应用

1. 登录到 `https://api.slack.com`
2. 点击页面右上角的 "Your Apps"
3. 点击 "Create New App"
4. 在弹出的窗口中点击 "From a manifest"
5. 在出现的窗口中填入以下manifest配置：

```json
{
  "display_information": {
    "name": "OpencodeBot",
    "description": "Slack connector for Opencode"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "OpencodeBot",
      "always_online": false
    },
    "slash_commands": [
      {
        "command": "/opencode",
        "description": "Send a message to Opencode",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ],
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

### 2. 配置OAuth & Permissions

1. 点击左侧边栏的 "OAuth & Permissions"
2. 点击 "Install to Workspace" 安装应用到您的工作区
3. 安装完成后，复制 "Bot User OAuth Token" 并保存备用
4. 建议创建一个专属的工作区来管理此集成

### 3. 生成应用级令牌

1. 点击左侧边栏的 "Basic Information"
2. 在右侧的 "App-Level Tokens" 部分，选择 "Generate Token and Scopes"
3. 为令牌命名（如"opencode-connection"）
4. 权限选择 `connections:write`
5. 生成并保存此令牌

### 4. 启用Socket Mode

1. 点击左侧边栏的 "Socket Mode"
2. 在右侧的 "Connect using Socket Mode" 部分选择 "Enable Socket Mode"
3. 确保以下功能已启用：
   - Interactivity & Shortcuts
   - Slash Commands
   - Event Subscriptions

## 环境变量配置

编辑 `.bashrc` 文件，添加以下环境变量：

```bash
export SLACK_BOT_TOKEN=xoxb-...      # Bot User OAuth Token
export SLACK_APP_TOKEN=xapp-...      # 应用级令牌
export SLACK_USERNAME=your_username  # 您的Slack用户名
export OPENCODE_CONNECT_SHELL=1      # 可选：启用Shell模式（见下方说明）
```

保存后重新加载配置：

```bash
source ~/.bashrc
```

## 使用指南

### 启动

在命令行中执行以下命令启动opencode并启用Slack连接：

```bash
CONNECT_SLACK=1 opencode
```

### 验证连接

1. opencode启动后，您将在Slack中收到来自OpencodeBot的直接消息，表示连接已成功建立
2. 首次使用时，建议发送简短的测试指令（如"hello"）来验证opencode是否正常工作

### 日常使用

通过Slack向OpencodeBot发送您的需求和指令，opencode将在其空闲时处理并返回输出内容。

## 故障排除

- 如果连接失败，请检查所有令牌是否正确配置
- 确认Slack应用的权限设置是否完整
- 验证Socket Mode是否已启用
- 检查防火墙设置是否阻止了WebSocket连接

---

## 进阶：多实例模式（Channel模式）

当您需要同时运行多个opencode实例时（例如在不同项目目录中），需要使用Channel模式。

### 为什么需要Channel模式？

DM模式使用Slack的Socket Mode，它会将消息随机分发给多个连接中的一个。如果两个opencode实例同时使用DM模式，消息会随机发送到其中一个，导致消息丢失。

Channel模式让每个实例监听不同的channel，互不干扰。

### 使用方法

1. 在Slack中创建一个channel（如 `#project-a`）
2. 邀请OpencodeBot加入该channel
3. 启动时指定channel名称：

```bash
CONNECT_SLACK=#project-a opencode
```

### 多实例示例

```bash
# 终端1 - 项目A
cd ~/projects/project-a
CONNECT_SLACK=#project-a opencode

# 终端2 - 项目B  
cd ~/projects/project-b
CONNECT_SLACK=#project-b opencode
```

### 轮询机制说明

Channel模式通过轮询获取消息：
- 活跃期（有消息或任务完成后2分钟内）：每3秒轮询
- 空闲期（超过2分钟无活动）：每60秒轮询

如需实时响应，建议使用DM模式（但同一时间只能有一个DM实例）。

## 注意事项

- 建议在专用的Slack工作区中进行此集成
- 定期轮换API令牌以确保安全性
- 保持插件文件的最新版本以获得最佳兼容性

---

## Shell模式

Shell模式允许通过在消息前加 `!` 前缀来直接执行shell命令，绕过AI处理。

### 安全说明

**Shell模式默认禁用**，因为它存在以下安全风险：

- 命令直接执行，无任何过滤或确认
- 以运行opencode的用户权限执行
- 如果Slack账号被盗用，攻击者可在服务器上执行任意命令

### 启用方法

如需启用Shell模式，设置环境变量：

```bash
export OPENCODE_CONNECT_SHELL=1
```

### 使用方法

启用后，在消息前加 `!` 即可直接执行shell命令：

```
!git status
!ls -la
!pwd
```

命令在opencode的工作目录中执行，有30秒超时限制。

### 建议

- 仅在可信环境中启用
- 考虑使用受限用户或容器运行opencode
- 确保Slack工作区是私有的
