import * as os from 'os';
import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';

interface SlackSyncConfig {
  slackBotToken?: string;
  slackAppToken?: string;
  slackUsername?: string;
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

const sendDM = async (client: WebClient, userId: string, message: string): Promise<void> => {
  const conversation = await client.conversations.open({ users: userId });
  if (!conversation.channel?.id) throw new Error('Failed to open DM channel');
  
  await client.chat.postMessage({
    channel: conversation.channel.id,
    text: message,
  });
};

const OpenCodeSlackSyncPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  if (!process.env.CONNECT_SLACK) {
    return {};
  }

  const config: SlackSyncConfig = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackUsername: process.env.SLACK_USERNAME,
  };

  if (!config.slackUsername) {
    return {};
  }

  const slackUsername = config.slackUsername;
  const slackClient = config.slackBotToken ? new WebClient(config.slackBotToken) : null;
  const opencodeClient = input.client;

  let cachedUserId: string | null = null;
  let cachedDmChannelId: string | null = null;
  const pendingText = new Map<string, string>();
  const instanceId = Math.floor(1000 + Math.random() * 9000);
  
  const getTargetUserId = async (): Promise<string | null> => {
    if (cachedUserId) return cachedUserId;
    if (!slackClient) return null;
    cachedUserId = await findUserByName(slackClient, slackUsername);
    return cachedUserId;
  };

  const getDmChannelId = async (): Promise<string | null> => {
    if (cachedDmChannelId) return cachedDmChannelId;
    if (!slackClient) return null;
    const userId = await getTargetUserId();
    if (!userId) return null;
    const conversation = await slackClient.conversations.open({ users: userId });
    cachedDmChannelId = conversation.channel?.id ?? null;
    return cachedDmChannelId;
  };

  if (slackClient) {
    (async () => {
      try {
        const userId = await findUserByName(slackClient, slackUsername);
        if (userId) {
          const hostname = os.hostname();
          const path = input.directory;
          await sendDM(slackClient, userId, `*###opencode instance (${instanceId}) from ${hostname}:${path} started.###*`);
        }
      } catch {}
    })();
  }

  if (config.slackAppToken) {
    const socketClient = new SocketModeClient({ appToken: config.slackAppToken });
    
    socketClient.on('message', async ({ event, ack }) => {
      await ack();
      
      if (event.channel_type !== 'im') return;
      if (event.subtype) return;
      if (event.bot_id) return;
      
      const dmChannelId = await getDmChannelId();
      if (event.channel !== dmChannelId) return;
      
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
          const userId = await getTargetUserId();
          if (userId) {
            const maxLen = 3000;
            const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...(truncated)' : text;
            const summary = `_opencode session [${instanceId}]_\n${truncated}`;
            sendDM(slackClient, userId, summary).catch(() => {});
          }
          pendingText.delete(sessionId);
        }
      }
    },
  };
};

export default OpenCodeSlackSyncPlugin;
export { OpenCodeSlackSyncPlugin };
export type { SlackSyncConfig };
