# Opencode-Slack连接插件安装配置文档

## 演示视频

[![opencode_connect_demo](https://github.com/delock/opencode_connect/assets/149414334/placeholder)](https://github.com/delock/opencode_connect/releases/download/v0.1/opencode_connect_demo.mp4)

*点击视频查看演示或下载：[opencode_connect_demo.mp4](https://github.com/delock/opencode_connect/releases/download/v0.1/opencode_connect_demo.mp4)*

<video src="https://github.com/delock/opencode_connect/releases/download/v0.1/opencode_connect_demo.mp4" width="640" height="360" controls></video>

## 概述

本文档介绍如何安装和配置Opencode-Slack连接插件，实现通过Slack控制Opencode的工作流程。该插件通过WebSocket协议建立实时连接，提供双向通信能力。

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
2. 复制 "Bot User OAuth Token" 并保存备用
3. 根据提示选择 "Install to Workspace" 安装应用到您的工作区
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

## 插件配置

### 1. 复制插件文件

将 `opencode-connect.ts` 文件复制到以下目录之一：

```
~/.config/opencode/plugins/
```

或

```
~/.opencode/plugins/
```

### 2. 配置环境变量

编辑 `.bashrc` 文件，添加以下环境变量：

```bash
export SLACK_APP_TOKEN=xapp-...  # 替换为前面生成的应用级令牌
export SLACK_BOT_TOKEN=xoxb-... # 替换为OAuth & Permissions页面的Bot User OAuth Token
export SLACK_USERNAME=<your slack username>  # 替换为您的Slack用户名
```

### 3. 获取用户ID

在Slack应用中，进入您指定的workspace，点击私信（Direct Message）功能，获取您的用户ID，并将其添加到环境变量中（如需要）。

### 4. 重新加载配置

保存 `.bashrc` 文件后，重新加载环境变量：

```bash
source ~/.bashrc
```

## 验证安装

完成上述配置后，启动opencode服务，验证Slack与opencode的连接是否成功。您应该能够通过Slack发送命令来控制opencode的工作流程。

## 使用指南

完成以上配置后，可通过以下步骤启动和使用Opencode-Slack集成：

1. **启动集成**：在命令行中执行以下命令启动opencode并启用Slack连接：
   ```
   CONNECT_SLACK=1 opencode
   ```

2. **等待初始化**：opencode将开始安装依赖项（此过程可能需要几分钟时间），随后界面将显示出来。

3. **接收连接确认**：在Slack中，您将收到来自OpencodeBot的直接消息，表示连接已成功建立。

4. **发送指令**：通过Slack向OpencodeBot发送您的需求和指令，opencode将在其空闲时处理并返回输出内容。

5. **首次验证**：首次使用时，建议发送简短的测试指令（如"hello"）来验证opencode是否正常工作。

## 故障排除

- 如果连接失败，请检查所有令牌是否正确配置
- 确认Slack应用的权限设置是否完整
- 验证Socket Mode是否已启用
- 检查防火墙设置是否阻止了WebSocket连接

## 注意事项

- 建议在专用的Slack工作区中进行此集成，以便更好地管理权限
- 定期轮换API令牌以确保安全性
- 保持插件文件的最新版本以获得最佳兼容性
