import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';

const execAsync = promisify(exec);

interface SlackSyncConfig {
  slackBotToken?: string;
  slackAppToken?: string;
  slackUsername?: string;
  channelMode?: boolean;
  channelName?: string;
}

const FAST_POLL_INTERVAL_MS = 3_000;
const SLOW_POLL_INTERVAL_MS = 60_000;
const SLOW_POLL_THRESHOLD_MS = 2 * 60 * 1000;
const SHELL_COMMAND_TIMEOUT_MS = 30_000; // 30 seconds timeout for shell commands
const ENABLE_SHELL_MODE = !!process.env.OPENCODE_CONNECT_SHELL; // Shell mode disabled by default for security

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

const isShellCommand = (text: string): boolean => {
  return ENABLE_SHELL_MODE && text.startsWith('!') && text.length > 1;
};

const executeShellCommand = async (command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: SHELL_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    if (execError.killed) {
      return { stdout: '', stderr: 'Command timed out', exitCode: 124 };
    }
    return {
      stdout: execError.stdout || '',
      stderr: execError.stderr || String(error),
      exitCode: execError.code || 1,
    };
  }
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
  const workingDirectory = input.directory;

  let cachedUserId: string | null = null;
  let cachedChannelId: string | null = null;
  let cachedBotUserId: string | null = null;
  let lastSeenTs: string | null = null;
  let lastActivityTime: number = Date.now();
  let pollTimerId: ReturnType<typeof setTimeout> | null = null;
  const pendingText = new Map<string, string>();
  const instanceId = Math.floor(1000 + Math.random() * 9000);
  
  interface PendingQuestion {
    sessionId: string;
    partId: string;
    requestId: string;
    options: Array<{ label: string; description?: string }>;
    multiple: boolean;
    custom: boolean;
  }
  let pendingQuestion: PendingQuestion | null = null;
  
  const replyToQuestion = async (requestId: string, answers: string[][]): Promise<void> => {
    // Use the SDK's internal client to make the request (it's properly configured)
    // @ts-ignore - accessing internal _client
    const internalClient = opencodeClient._client;
    const result = await internalClient.post({
      url: `/question/${requestId}/reply`,
      headers: { 'Content-Type': 'application/json' },
      body: { answers },
    });
    if (result.error) {
      throw new Error(`Failed to reply to question: ${JSON.stringify(result.error)}`);
    }
  };
  
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

  const getBotUserId = async (): Promise<string | null> => {
    if (cachedBotUserId) return cachedBotUserId;
    if (!slackClient) return null;
    
    try {
      const authResult = await slackClient.auth.test();
      cachedBotUserId = authResult.user_id as string ?? null;
    } catch {
      cachedBotUserId = null;
    }
    return cachedBotUserId;
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

  const handleIncomingMessage = async (text: string): Promise<void> => {
    if (pendingQuestion) {
      const trimmed = text.trim();
      const numMatch = trimmed.match(/^(\d+)$/);
      
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        const { options, custom, requestId } = pendingQuestion;
        
        if (num >= 1 && num <= options.length) {
          const selected = options[num - 1].label;
          try {
            await replyToQuestion(requestId, [[selected]]);
            pendingQuestion = null;
          } catch (error) {
            await sendMessage(`_[${instanceId}] ⚠️ 回答失败: ${error}_`);
          }
          return;
        } else if (custom && num === options.length + 1) {
          await sendMessage(`_[${instanceId}] 请输入自定义回答:_`);
          return;
        } else {
          await sendMessage(`_[${instanceId}] ⚠️ 无效选项，请输入 1-${options.length}${custom ? ` 或 ${options.length + 1} 自定义` : ''}_`);
          return;
        }
      }
      
      if (pendingQuestion.custom) {
        try {
          await replyToQuestion(pendingQuestion.requestId, [[trimmed]]);
          pendingQuestion = null;
        } catch (error) {
          await sendMessage(`_[${instanceId}] ⚠️ 回答失败: ${error}_`);
        }
        return;
      }
    }
    
    if (isShellCommand(text)) {
      const command = text.slice(1).trim();
      const result = await executeShellCommand(command, workingDirectory);
      
      let output = '';
      if (result.stdout) {
        output += result.stdout;
      }
      if (result.stderr) {
        output += (output ? '\n' : '') + result.stderr;
      }
      if (!output) {
        output = result.exitCode === 0 ? '(no output)' : `(exit code: ${result.exitCode})`;
      }
      
      const maxLen = 3000;
      const truncated = output.length > maxLen ? output.slice(0, maxLen) + '...(truncated)' : output;
      const response = `_shell [${instanceId}]_ \`${command}\`\n\`\`\`\n${truncated}\n\`\`\``;
      await sendMessage(response);
    } else {
      await opencodeClient.tui.appendPrompt({ body: { text } });
      await opencodeClient.tui.submitPrompt({});
    }
  };

  const isMessageFromBot = (msg: { bot_id?: string; user?: string }, botUserId: string | null): boolean => {
    return !!msg.bot_id || (!!botUserId && msg.user === botUserId);
  };

  const isNewUserMessage = (msg: { subtype?: string; ts?: string }): boolean => {
    if (msg.subtype) return false;
    if (lastSeenTs && msg.ts && msg.ts <= lastSeenTs) return false;
    return true;
  };

  const getCurrentPollInterval = (): number => {
    const timeSinceActivity = Date.now() - lastActivityTime;
    return timeSinceActivity >= SLOW_POLL_THRESHOLD_MS ? SLOW_POLL_INTERVAL_MS : FAST_POLL_INTERVAL_MS;
  };

  const scheduleNextPoll = (): void => {
    if (pollTimerId) {
      clearTimeout(pollTimerId);
    }
    const interval = getCurrentPollInterval();
    pollTimerId = setTimeout(() => {
      pollMessages().catch(() => {});
    }, interval);
  };

  const pollMessages = async (): Promise<void> => {
    if (!slackClient) return;
    
    try {
      const channelId = await getTargetChannelId();
      if (!channelId) return;
      
      const botUserId = await getBotUserId();
      
      const result = await slackClient.conversations.history({
        channel: channelId,
        limit: 10,
        oldest: lastSeenTs || undefined,
      });
      
      if (!result.messages || result.messages.length === 0) {
        scheduleNextPoll();
        return;
      }
      
      const newMessages = result.messages
        .filter(msg => !isMessageFromBot(msg, botUserId) && isNewUserMessage(msg))
        .sort((a, b) => parseFloat(a.ts || '0') - parseFloat(b.ts || '0'));
      
      if (newMessages.length === 0) {
        scheduleNextPoll();
        return;
      }

      lastActivityTime = Date.now();
      
      for (const msg of newMessages) {
        if (!msg.text || !msg.ts) continue;
        
        lastSeenTs = msg.ts;
        
        try {
          await handleIncomingMessage(msg.text);
        } catch {}
      }
      
      scheduleNextPoll();
    } catch {
      scheduleNextPoll();
    }
  };

  const initializeLastSeenTs = async (): Promise<void> => {
    if (!slackClient) return;
    
    const channelId = await getTargetChannelId();
    if (!channelId) return;
    
    const result = await slackClient.conversations.history({
      channel: channelId,
      limit: 1,
    });
    
    if (result.messages && result.messages.length > 0) {
      lastSeenTs = result.messages[0].ts || null;
    }
  };

  if (slackClient) {
    (async () => {
      try {
        const hostname = os.hostname();
        const path = input.directory;
        await sendMessage(`*###opencode instance (${instanceId}) from ${hostname}:${path} started.###*`);
        await initializeLastSeenTs();
        
        if (channelMode) {
          scheduleNextPoll();
        }
      } catch {}
    })();
  }

  if (!channelMode && config.slackAppToken) {
    const socketClient = new SocketModeClient({ appToken: config.slackAppToken });
    
    socketClient.on('message', async ({ event, ack }) => {
      await ack();
      
      if (event.subtype) return;
      if (event.bot_id) return;
      if (event.channel_type !== 'im') return;
      
      const targetChannelId = await getTargetChannelId();
      if (!targetChannelId) return;
      if (event.channel !== targetChannelId) return;
      
      const text = event.text;
      if (!text) return;
      
      try {
        await handleIncomingMessage(text);
      } catch {}
    });
    
    socketClient.start().catch(() => {});
  }

  let activeMainSessionId: string | null = null;

  return {
    event: async ({ event }) => {
      if (!slackClient) return;
      
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (part.type === 'text') {
          const sessionId = part.sessionID;
          if (!activeMainSessionId) {
            activeMainSessionId = sessionId;
          }
          const existing = pendingText.get(sessionId) || '';
          if (event.properties.delta) {
            pendingText.set(sessionId, existing + event.properties.delta);
          } else {
            pendingText.set(sessionId, part.text);
          }
        }
      }
      
      if (event.type === 'question.asked') {
        const questionRequest = event.properties as { 
          id: string; 
          sessionID: string; 
          questions: Array<{ 
            question: string; 
            header?: string; 
            options: Array<{ label: string; description?: string }>; 
            multiple?: boolean;
            custom?: boolean;
          }>;
        };
        
        const requestId = questionRequest.id;
        const questions = questionRequest.questions || [];
        
        for (const q of questions) {
          const options = q.options || [];
          if (options.length === 0) continue;
          
          const custom = q.custom !== false;
          
          let msg = `_[${instanceId}] ❓ ${q.question}_\n`;
          options.forEach((opt, idx) => {
            msg += `*${idx + 1}.* ${opt.label}`;
            if (opt.description) {
              msg += ` - ${opt.description}`;
            }
            msg += '\n';
          });
          if (custom) {
            msg += `*${options.length + 1}.* _自定义回答_\n`;
          }
          msg += `\n_回复数字选择 (1-${options.length}${custom ? ` 或 ${options.length + 1} 自定义` : ''})_`;
          
          pendingQuestion = {
            sessionId: questionRequest.sessionID,
            partId: '',
            requestId,
            options,
            multiple: q.multiple || false,
            custom,
          };
          
          await sendMessage(msg);
        }
      }
      
      if (event.type === 'session.created') {
        const session = event.properties.info;
        if (session.parentID && session.parentID === activeMainSessionId) {
          pendingText.delete(activeMainSessionId);
        }
      }
      
      if (event.type === 'session.idle') {
        const sessionId = event.properties.sessionID;
        
        try {
          const sessions = await opencodeClient.session.list({});
          const session = sessions.find(s => s.id === sessionId);
          if (session?.parentID) {
            pendingText.delete(sessionId);
            return;
          }
        } catch {}
        
        const text = pendingText.get(sessionId);
        if (text && text.trim().length > 0) {
          const maxLen = 3000;
          const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...(truncated)' : text;
          const summary = `_opencode session [${instanceId}]_\n${truncated}`;
          sendMessage(summary).catch(() => {});
          pendingText.delete(sessionId);
        }
        
        if (sessionId === activeMainSessionId) {
          activeMainSessionId = null;
        }
        
        if (channelMode) {
          lastActivityTime = Date.now();
          pollMessages().catch(() => {});
        }
      }
    },
  };
};

export default OpenCodeSlackSyncPlugin;
export { OpenCodeSlackSyncPlugin };
export type { SlackSyncConfig };
