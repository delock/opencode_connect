import * as os from 'os';
import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';

interface SlackSyncConfig {
  slackBotToken?: string;
  slackAppToken?: string;
  slackUsername?: string;
  channelMode?: boolean;
  channelName?: string;
}

const findUserByName = async (client: WebClient, username: string): Promise<string | null> => {
  const result = await client.users.list({ limit: 200 });
  if (!result.members) return null;
  
  const user = result.members.find(m => 
    m.name === username || 
    m.profile?.display_name === username ||
    m.profile?.display_name_normalized === username
  );
  return user?.id ?? null;
};

const findChannelByName = async (client: WebClient, channelName: string): Promise<string | null> => {
  const name = channelName.startsWith('#') ? channelName.slice(1) : channelName;
  
  const result = await client.conversations.list({ 
    limit: 200,
    types: 'public_channel,private_channel'
  });
  if (!result.channels) return null;
  
  const channel = result.channels.find(c => c.name === name);
  return channel?.id ?? null;
};

const sendDM = async (client: WebClient, userId: string, message: string): Promise<void> => {
  const conversation = await client.conversations.open({ users: userId });
  if (!conversation.channel?.id) throw new Error('Failed to open DM channel');
  
  await client.chat.postMessage({
    channel: conversation.channel.id,
    text: message,
  });
};

const sendToChannel = async (client: WebClient, channelId: string, message: string): Promise<void> => {
  await client.chat.postMessage({
    channel: channelId,
    text: message,
  });
};

const OpenCodeSlackSyncPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const connectSlack = process.env.CONNECT_SLACK;
  if (!connectSlack) {
    return {};
  }

  const channelMode = connectSlack.startsWith('#');
  const channelName = channelMode ? connectSlack : undefined;

  const config: SlackSyncConfig = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackUsername: process.env.SLACK_USERNAME,
    channelMode,
    channelName,
  };

  if (!channelMode && !config.slackUsername) {
    return {};
  }

  const slackUsername = config.slackUsername;
  const slackClient = config.slackBotToken ? new WebClient(config.slackBotToken) : null;
  const opencodeClient = input.client;

  let cachedUserId: string | null = null;
  let cachedChannelId: string | null = null;
  const pendingText = new Map<string, string>();
  const instanceId = Math.floor(1000 + Math.random() * 9000);
  
  const getTargetUserId = async (): Promise<string | null> => {
    if (channelMode) return null;
    if (cachedUserId) return cachedUserId;
    if (!slackClient || !slackUsername) return null;
    cachedUserId = await findUserByName(slackClient, slackUsername);
    return cachedUserId;
  };

  const getTargetChannelId = async (): Promise<string | null> => {
    if (cachedChannelId) return cachedChannelId;
    if (!slackClient) return null;
    
    if (channelMode && channelName) {
      cachedChannelId = await findChannelByName(slackClient, channelName);
    } else if (slackUsername) {
      const userId = await getTargetUserId();
      if (!userId) return null;
      const conversation = await slackClient.conversations.open({ users: userId });
      cachedChannelId = conversation.channel?.id ?? null;
    }
    return cachedChannelId;
  };

  const sendMessage = async (message: string): Promise<void> => {
    if (!slackClient) return;
    
    if (channelMode) {
      const channelId = await getTargetChannelId();
      if (channelId) {
        await sendToChannel(slackClient, channelId, message);
      }
    } else {
      const userId = await getTargetUserId();
      if (userId) {
        await sendDM(slackClient, userId, message);
      }
    }
  };

  if (slackClient) {
    (async () => {
      try {
        const hostname = os.hostname();
        const path = input.directory;
        await sendMessage(`*###opencode instance (${instanceId}) from ${hostname}:${path} started.###*`);
      } catch {}
    })();
  }

  if (config.slackAppToken) {
    const socketClient = new SocketModeClient({ appToken: config.slackAppToken });
    
    socketClient.on('message', async ({ event, ack }) => {
      await ack();
      
      if (event.subtype) return;
      if (event.bot_id) return;
      
      const targetChannelId = await getTargetChannelId();
      if (!targetChannelId) return;
      
      if (channelMode) {
        if (event.channel_type === 'im') return;
        if (event.channel !== targetChannelId) return;
      } else {
        if (event.channel_type !== 'im') return;
        if (event.channel !== targetChannelId) return;
      }
      
      const text = event.text;
      if (!text) return;
      
      try {
        await opencodeClient.tui.appendPrompt({ body: { text } });
        await opencodeClient.tui.submitPrompt({});
      } catch {}
    });
    
    socketClient.start().catch(() => {});
  }

  return {
    event: async ({ event }) => {
      if (!slackClient) return;
      
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (part.type === 'text') {
          const sessionId = part.sessionID;
          const existing = pendingText.get(sessionId) || '';
          if (event.properties.delta) {
            pendingText.set(sessionId, existing + event.properties.delta);
          } else {
            pendingText.set(sessionId, part.text);
          }
        }
      }
      
      if (event.type === 'session.idle') {
        const sessionId = event.properties.sessionID;
        const text = pendingText.get(sessionId);
        if (text && text.trim().length > 0) {
          const maxLen = 3000;
          const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...(truncated)' : text;
          const summary = `_opencode session [${instanceId}]_\n${truncated}`;
          sendMessage(summary).catch(() => {});
          pendingText.delete(sessionId);
        }
      }
    },
  };
};

export default OpenCodeSlackSyncPlugin;
export { OpenCodeSlackSyncPlugin };
export type { SlackSyncConfig };
