# OpenCode-Slack Connection Plugin Installation Guide

## Demo

![opencode_connect_demo](https://github.com/delock/opencode_connect/raw/master/images/opencode_connect_demo.gif)

## Overview

This document describes how to install and configure the OpenCode-Slack connection plugin to control OpenCode remotely via Slack.

## Installation Steps

### 1. Clone the Repository

First, clone the project from GitHub:

```
git clone https://github.com/delock/opencode_connect
```

### 2. Install Dependencies

Edit ~/.config/opencode/package.json or ~/.opencode/package.json and add the following dependencies:

```json
{
  "dependencies": {
    "@slack/socket-mode": "^2.0.5",
    "@slack/web-api": "^7.13.0"
  }
}
```

OpenCode will automatically install these dependencies on the first startup after modification.

### 3. Copy Plugin File

Copy the `opencode-connect.ts` file to one of the following directories:

```
~/.config/opencode/plugins/
```

or

```
~/.opencode/plugins/
```

## Slack App Configuration

### 1. Create a Slack App

1. Log in to `https://api.slack.com`
2. Click "Your Apps" in the top right corner
3. Click "Create New App"
4. In the popup window, click "From a manifest"
5. Enter the following manifest configuration:

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

### 2. Configure OAuth & Permissions

1. Click "OAuth & Permissions" in the left sidebar
2. Click "Install to Workspace" to install the app to your workspace
3. After installation, copy the "Bot User OAuth Token" and save it
4. It's recommended to create a dedicated workspace for this integration

### 3. Generate App-Level Token

1. Click "Basic Information" in the left sidebar
2. In the "App-Level Tokens" section, select "Generate Token and Scopes"
3. Name the token (e.g., "opencode-connection")
4. Select the `connections:write` scope
5. Generate and save this token

### 4. Enable Socket Mode

1. Click "Socket Mode" in the left sidebar
2. In the "Connect using Socket Mode" section, select "Enable Socket Mode"
3. Ensure the following features are enabled:
   - Interactivity & Shortcuts
   - Slash Commands
   - Event Subscriptions

## Environment Variables

Edit your `.bashrc` file and add the following environment variables:

```bash
export SLACK_BOT_TOKEN=xoxb-...      # Bot User OAuth Token
export SLACK_APP_TOKEN=xapp-...      # App-Level Token
export SLACK_USERNAME=your_username  # Your Slack username
export OPENCODE_CONNECT_SHELL=1      # Optional: Enable Shell mode (see below)
```

Reload the configuration:

```bash
source ~/.bashrc
```

## Usage Guide

### Starting

Run the following command to start OpenCode with Slack connection enabled:

```bash
CONNECT_SLACK=1 opencode
```

### Verify Connection

1. After OpenCode starts, you will receive a direct message from OpencodeBot in Slack, indicating a successful connection
2. For first-time use, send a short test message (e.g., "hello") to verify OpenCode is working properly

### Daily Use

Send your requests and instructions to OpencodeBot via Slack, and OpenCode will process them when idle and return the output.

## Troubleshooting

- If connection fails, verify all tokens are correctly configured
- Confirm Slack app permissions are complete
- Verify Socket Mode is enabled
- Check if firewall settings are blocking WebSocket connections

---

## Advanced: Multi-Instance Mode (Channel Mode)

When you need to run multiple OpenCode instances simultaneously (e.g., in different project directories), use Channel mode.

### Why Channel Mode?

DM mode uses Slack's Socket Mode, which randomly distributes messages to one of multiple connections. If two OpenCode instances use DM mode simultaneously, messages will be randomly sent to one of them, causing message loss.

Channel mode allows each instance to listen to different channels without interference.

### Usage

1. Create a channel in Slack (e.g., `#project-a`)
2. Invite OpencodeBot to join the channel
3. Specify the channel name when starting:

```bash
CONNECT_SLACK=#project-a opencode
```

### Multi-Instance Example

```bash
# Terminal 1 - Project A
cd ~/projects/project-a
CONNECT_SLACK=#project-a opencode

# Terminal 2 - Project B  
cd ~/projects/project-b
CONNECT_SLACK=#project-b opencode
```

### Polling Mechanism

Channel mode retrieves messages via polling:
- Active period (within 2 minutes of message or task completion): polls every 3 seconds
- Idle period (over 2 minutes of inactivity): polls every 60 seconds

For real-time responses, use DM mode (but only one DM instance can run at a time).

## Notes

- It's recommended to use a dedicated Slack workspace for this integration
- Rotate API tokens regularly for security
- Keep the plugin file up to date for best compatibility

---

## Shell Mode

Shell mode allows executing shell commands directly by prefixing messages with `!`, bypassing AI processing.

### Security Notice

**Shell mode is disabled by default** due to the following security risks:

- Commands are executed directly without any filtering or confirmation
- Commands run with the permissions of the user running OpenCode
- If your Slack account is compromised, attackers can execute arbitrary commands on your server

### Enabling

To enable Shell mode, set the environment variable:

```bash
export OPENCODE_CONNECT_SHELL=1
```

### Usage

Once enabled, prefix messages with `!` to execute shell commands directly:

```
!git status
!ls -la
!pwd
```

Commands are executed in OpenCode's working directory with a 30-second timeout.

### Recommendations

- Only enable in trusted environments
- Consider running OpenCode with a restricted user or in a container
- Ensure your Slack workspace is private
