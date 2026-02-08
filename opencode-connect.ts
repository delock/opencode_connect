import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';

const execAsync = promisify(exec);

// ============================================================
// Shared types and constants
// ============================================================

const SHELL_COMMAND_TIMEOUT_MS = 30_000;
const ENABLE_SHELL_MODE = !!process.env.OPENCODE_CONNECT_SHELL;

// SQS message protocol types
interface SqsIncomingMessage {
  type: 'prompt' | 'permission_reply' | 'question_reply' | 'shell';
  text?: string;
  permissionId?: string;
  response?: 'once' | 'always' | 'reject';
  requestId?: string;
  answers?: string[][];
  command?: string;
}

interface SqsOutgoingMessage {
  type: 'output' | 'permission' | 'question' | 'status' | 'shell_output' | 'error';
  [key: string]: unknown;
}

// ============================================================
// Shared utilities
// ============================================================

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

// ============================================================
// Slack transport
// ============================================================

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

// ============================================================
// SQS transport
// ============================================================

const SQS_POLL_INTERVAL_MS = 1_000; // Short interval between long-poll cycles
const SQS_WAIT_TIME_SECONDS = 20;   // SQS long polling wait time
const SQS_MAX_MESSAGE_SIZE = 256 * 1024; // 256KB SQS limit

interface SqsTransport {
  sendMessage: (msg: SqsOutgoingMessage) => Promise<void>;
  startPolling: (handler: (msg: SqsIncomingMessage) => Promise<void>) => void;
}

const createSqsTransport = async (): Promise<SqsTransport | null> => {
  const queueToWeb = process.env.AWS_SQS_QUEUE_TO_WEB;
  const queueFromWeb = process.env.AWS_SQS_QUEUE_FROM_WEB;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

  if (!queueToWeb || !queueFromWeb) return null;

  // Dynamic import to avoid requiring AWS SDK when not using SQS
  const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');

  const sqsClient = new SQSClient({ region });

  const sendMessage = async (msg: SqsOutgoingMessage): Promise<void> => {
    const body = JSON.stringify(msg);
    if (body.length > SQS_MAX_MESSAGE_SIZE) {
      // Truncate output messages if too large
      if (msg.type === 'output' && typeof msg.text === 'string') {
        const truncated = { ...msg, text: (msg.text as string).slice(0, 200000) + '\n...(truncated)' };
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: queueToWeb,
          MessageBody: JSON.stringify(truncated),
        }));
        return;
      }
    }
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueToWeb,
      MessageBody: body,
    }));
  };

  const startPolling = (handler: (msg: SqsIncomingMessage) => Promise<void>) => {
    const poll = async () => {
      try {
        const result = await sqsClient.send(new ReceiveMessageCommand({
          QueueUrl: queueFromWeb,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: SQS_WAIT_TIME_SECONDS,
        }));

        if (result.Messages) {
          for (const sqsMsg of result.Messages) {
            if (!sqsMsg.Body || !sqsMsg.ReceiptHandle) continue;
            try {
              const parsed = JSON.parse(sqsMsg.Body) as SqsIncomingMessage;
              await handler(parsed);
            } catch {
              // Invalid message, skip
            }
            // Delete message after processing
            try {
              await sqsClient.send(new DeleteMessageCommand({
                QueueUrl: queueFromWeb,
                ReceiptHandle: sqsMsg.ReceiptHandle,
              }));
            } catch {
              // Delete failed, message will reappear after visibility timeout
            }
          }
        }
      } catch {
        // Poll error, retry after interval
      }

      setTimeout(poll, SQS_POLL_INTERVAL_MS);
    };

    poll();
  };

  return { sendMessage, startPolling };
};

// ============================================================
// Main plugin
// ============================================================

const OpenCodeConnectPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const connectSlack = process.env.CONNECT_SLACK;
  const connectMsg = process.env.CONNECT_MSG;

  if (!connectSlack && !connectMsg) {
    return {};
  }

  const opencodeClient = input.client;
  const workingDirectory = input.directory;
  const instanceId = Math.floor(1000 + Math.random() * 9000);

  let activeMainSessionId: string | null = null;
  const pendingText = new Map<string, string>();
  const subSessionIds = new Set<string>();

  interface PendingQuestion {
    sessionId: string;
    partId: string;
    requestId: string;
    options: Array<{ label: string; description?: string }>;
    multiple: boolean;
    custom: boolean;
  }
  let pendingQuestion: PendingQuestion | null = null;

  interface PendingPermission {
    sessionId: string;
    permissionId: string;
    title: string;
  }
  let pendingPermission: PendingPermission | null = null;

  const replyToQuestion = async (requestId: string, answers: string[][]): Promise<void> => {
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

  const replyToPermission = async (sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject'): Promise<void> => {
    // @ts-ignore - accessing internal _client
    const internalClient = opencodeClient._client;
    const result = await internalClient.post({
      url: `/session/${sessionId}/permissions/${permissionId}`,
      headers: { 'Content-Type': 'application/json' },
      body: { response },
    });
    if (result.error) {
      throw new Error(`Failed to reply to permission: ${JSON.stringify(result.error)}`);
    }
  };

  // Look up tool call details for a permission event
  const lookupToolDetails = async (sessionID: string, tool: { messageID: string; callID: string }): Promise<{ toolName?: string; args?: string } | null> => {
    try {
      const messagesResult = await opencodeClient.session.messages({
        path: { id: sessionID },
      });
      const messages = messagesResult.data as Array<{
        id: string;
        parts?: Array<{
          type: string;
          id?: string;
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          input?: string;
        }>;
      }> | undefined;

      const targetMsg = messages?.find(m => m.id === tool.messageID);
      if (targetMsg?.parts) {
        const toolPart = targetMsg.parts.find(p =>
          (p.type === 'tool-invocation' || p.type === 'tool-call') &&
          (p.id === tool.callID || p.toolCallId === tool.callID)
        );
        if (toolPart) {
          const argsObj = toolPart.args || (toolPart.input ? { input: toolPart.input } : null);
          const argsStr = argsObj ? JSON.stringify(argsObj) : undefined;
          return {
            toolName: toolPart.toolName,
            args: argsStr ? (argsStr.length > 500 ? argsStr.slice(0, 500) + '...' : argsStr) : undefined,
          };
        }
      }
    } catch {
      // Failed to look up
    }
    return null;
  };

  // ============================================================
  // SQS mode (CONNECT_MSG)
  // ============================================================

  if (connectMsg) {
    const sqsTransport = await createSqsTransport();
    if (!sqsTransport) {
      // Missing queue URLs, skip
      return {};
    }

    const sendSqs = sqsTransport.sendMessage;

    // Send status announcement
    const hostname = os.hostname();
    await sendSqs({
      type: 'status',
      status: 'connected',
      instanceId,
      hostname,
      directory: workingDirectory,
    });

    // Handle incoming SQS messages
    const handleSqsMessage = async (msg: SqsIncomingMessage): Promise<void> => {
      switch (msg.type) {
        case 'prompt': {
          if (!msg.text) return;
          const text = msg.text.trim();

          // Shell commands
          if (isShellCommand(text)) {
            const command = text.slice(1).trim();
            const result = await executeShellCommand(command, workingDirectory);
            let output = '';
            if (result.stdout) output += result.stdout;
            if (result.stderr) output += (output ? '\n' : '') + result.stderr;
            if (!output) output = result.exitCode === 0 ? '(no output)' : `(exit code: ${result.exitCode})`;
            await sendSqs({
              type: 'shell_output',
              command,
              output,
              exitCode: result.exitCode,
            });
            return;
          }

          // Regular prompt — send to OpenCode
          await opencodeClient.tui.appendPrompt({ body: { text: msg.text } });
          await opencodeClient.tui.submitPrompt({});
          break;
        }

        case 'permission_reply': {
          if (!msg.permissionId || !msg.response) return;
          if (!pendingPermission) {
            await sendSqs({ type: 'error', message: 'No pending permission request' });
            return;
          }
          try {
            await replyToPermission(pendingPermission.sessionId, msg.permissionId, msg.response);
            pendingPermission = null;
          } catch (error) {
            await sendSqs({ type: 'error', message: `Failed to respond to permission: ${error}` });
          }
          break;
        }

        case 'question_reply': {
          if (!msg.requestId || !msg.answers) return;
          if (!pendingQuestion) {
            await sendSqs({ type: 'error', message: 'No pending question' });
            return;
          }
          try {
            await replyToQuestion(msg.requestId, msg.answers);
            pendingQuestion = null;
          } catch (error) {
            await sendSqs({ type: 'error', message: `Failed to reply to question: ${error}` });
          }
          break;
        }

        case 'shell': {
          if (!msg.command) return;
          if (!ENABLE_SHELL_MODE) {
            await sendSqs({ type: 'error', message: 'Shell mode is disabled. Set OPENCODE_CONNECT_SHELL=1 to enable.' });
            return;
          }
          const result = await executeShellCommand(msg.command, workingDirectory);
          let output = '';
          if (result.stdout) output += result.stdout;
          if (result.stderr) output += (output ? '\n' : '') + result.stderr;
          if (!output) output = result.exitCode === 0 ? '(no output)' : `(exit code: ${result.exitCode})`;
          await sendSqs({
            type: 'shell_output',
            command: msg.command,
            output,
            exitCode: result.exitCode,
          });
          break;
        }
      }
    };

    // Start polling for incoming messages
    sqsTransport.startPolling(handleSqsMessage);

    // Return event hooks for OpenCode events
    return {
      event: async ({ event }) => {
        if (event.type === 'message.part.updated') {
          const part = event.properties.part;
          if (part.type === 'text') {
            const sessionId = part.sessionID;
            if (!activeMainSessionId) {
              activeMainSessionId = sessionId;
            }
            if (subSessionIds.has(sessionId)) return;
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

            pendingQuestion = {
              sessionId: questionRequest.sessionID,
              partId: '',
              requestId,
              options,
              multiple: q.multiple || false,
              custom,
            };

            await sendSqs({
              type: 'question',
              requestId,
              sessionId: questionRequest.sessionID,
              question: q.question,
              header: q.header,
              options,
              multiple: q.multiple || false,
              custom,
            });
          }
        }

        if (event.type === 'permission.asked') {
          const permission = event.properties as {
            id: string;
            sessionID: string;
            permission: string;
            patterns?: string[];
            tool?: { messageID: string; callID: string };
          };

          let toolName: string | undefined;
          let toolArgs: string | undefined;
          if (permission.tool?.messageID) {
            const details = await lookupToolDetails(permission.sessionID, permission.tool);
            if (details) {
              toolName = details.toolName;
              toolArgs = details.args;
            }
          }

          pendingPermission = {
            sessionId: permission.sessionID,
            permissionId: permission.id,
            title: permission.permission,
          };

          await sendSqs({
            type: 'permission',
            permissionId: permission.id,
            sessionId: permission.sessionID,
            permission: permission.permission,
            patterns: permission.patterns,
            toolName,
            toolArgs,
          });
        }

        if (event.type === 'session.created') {
          const session = event.properties.info;
          if (session.parentID) {
            subSessionIds.add(session.id);
            if (session.parentID === activeMainSessionId) {
              pendingText.delete(activeMainSessionId);
            }
          }
        }

        if (event.type === 'session.idle') {
          const sessionId = event.properties.sessionID;

          if (subSessionIds.has(sessionId)) {
            subSessionIds.delete(sessionId);
            pendingText.delete(sessionId);
            return;
          }

          const text = pendingText.get(sessionId);
          if (text && text.trim().length > 0) {
            await sendSqs({
              type: 'output',
              text,
              sessionId,
              instanceId,
            });
            pendingText.delete(sessionId);
          }

          if (sessionId === activeMainSessionId) {
            activeMainSessionId = null;
          }
        }
      },
    };
  }

  // ============================================================
  // Slack mode (CONNECT_SLACK)
  // ============================================================

  if (!connectSlack) return {};

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

  let cachedUserId: string | null = null;
  let userIdLookedUp = false;
  let cachedChannelId: string | null = null;
  let cachedBotUserId: string | null = null;
  let lastSeenTs: string | null = null;
  let lastActivityTime: number = Date.now();
  let pollTimerId: ReturnType<typeof setTimeout> | null = null;
  const processedMessageIds = new Set<string>();
  
  const trackProcessedMessage = (msgId: string): boolean => {
    if (processedMessageIds.has(msgId)) return false;
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 200) {
      const first = processedMessageIds.values().next().value;
      if (first) processedMessageIds.delete(first);
    }
    return true;
  };

  const getTargetUserId = async (): Promise<string | null> => {
    if (userIdLookedUp) return cachedUserId;
    if (!slackClient || !slackUsername) return null;
    cachedUserId = await findUserByName(slackClient, slackUsername);
    userIdLookedUp = true;
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

  let isProcessingMessage = false;

  const handleIncomingMessage = async (text: string): Promise<void> => {
    if (isProcessingMessage) {
      const fs = await import('fs');
      fs.appendFileSync('/tmp/opencode-dedup.log', `[${new Date().toISOString()}] SKIPPED (busy): ${text.slice(0, 80)}\n`);
      return;
    }
    isProcessingMessage = true;
    try {
      await handleIncomingMessageInner(text);
    } finally {
      isProcessingMessage = false;
    }
  };

  const handleIncomingMessageInner = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    
    if (trimmed.startsWith('\\') && trimmed.length > 1) {
      const command = trimmed.slice(1);
      
      // Add future backslash commands here
      
      await sendMessage(`_[${instanceId}] ⚠️ Unknown command: \\${command}_`);
      return;
    }
    
    if (trimmed.startsWith('/')) {
      await sendMessage(`_[${instanceId}] ⚠️ Command mode not supported_`);
      return;
    }
    
    if (pendingPermission) {
      const trimmed = text.trim().toLowerCase();
      const { sessionId, permissionId, title } = pendingPermission;
      
      let response: 'once' | 'always' | 'reject' | null = null;
      if (trimmed === '1' || trimmed === 'y' || trimmed === 'yes' || trimmed === 'once') {
        response = 'once';
      } else if (trimmed === '2' || trimmed === 'always') {
        response = 'always';
      } else if (trimmed === '3' || trimmed === 'n' || trimmed === 'no' || trimmed === 'reject') {
        response = 'reject';
      }
      
      if (response) {
        try {
          await replyToPermission(sessionId, permissionId, response);
          pendingPermission = null;
          await sendMessage(`_[${instanceId}] ✓ Permission ${response === 'reject' ? 'denied' : 'granted'} (${response})_`);
        } catch (error) {
          await sendMessage(`_[${instanceId}] ⚠️ Failed to respond: ${error}_`);
        }
        return;
      } else {
        await sendMessage(`_[${instanceId}] ⚠️ Invalid response. Reply: 1/y/yes/once, 2/always, or 3/n/no/reject_`);
        return;
      }
    }
    
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
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + result.stderr;
      if (!output) output = result.exitCode === 0 ? '(no output)' : `(exit code: ${result.exitCode})`;
      
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

  const isMessageFromTargetUser = (msg: { user?: string }, targetUserId: string | null): boolean => {
    if (!targetUserId) return false;
    return msg.user === targetUserId;
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
      const targetUserId = await getTargetUserId();
      
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
        .filter(msg => !isMessageFromBot(msg, botUserId) && isMessageFromTargetUser(msg, targetUserId) && isNewUserMessage(msg))
        .sort((a, b) => parseFloat(a.ts || '0') - parseFloat(b.ts || '0'));
      
      if (newMessages.length === 0) {
        scheduleNextPoll();
        return;
      }

      lastActivityTime = Date.now();
      
      for (const msg of newMessages) {
        if (!msg.text || !msg.ts) continue;
        lastSeenTs = msg.ts;
        const msgId = (msg as { client_msg_id?: string }).client_msg_id || msg.ts;
        if (!msgId || !trackProcessedMessage(msgId)) continue;
        
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
        
        let announcement = `*###opencode instance (${instanceId}) from ${hostname}:${path} started.###*`;
        
        if (slackUsername) {
          const userId = await getTargetUserId();
          if (userId) {
            announcement += `\n_Listening for messages from: *${slackUsername}*_`;
          } else {
            announcement += `\n⚠️ *WARNING: User "${slackUsername}" not found in Slack workspace. No messages will be processed.*`;
          }
        } else if (channelMode) {
          announcement += `\n⚠️ *WARNING: SLACK_USERNAME not set. No messages will be processed.*`;
        }
        
        await sendMessage(announcement);
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
      
      const msgId = event.client_msg_id || event.ts;
      if (!msgId || !trackProcessedMessage(msgId)) return;
      
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
          if (subSessionIds.has(sessionId)) return;
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
      
      if (event.type === 'permission.asked') {
        const permission = event.properties as {
          id: string;
          sessionID: string;
          permission: string;
          patterns?: string[];
          tool?: { messageID: string; callID: string };
          metadata?: Record<string, unknown>;
        };
        
        let msg = `_[${instanceId}] 🔐 Permission Request_\n`;
        msg += `*${permission.permission}*\n`;
        if (permission.patterns && permission.patterns.length > 0) {
          msg += `Pattern: \`${permission.patterns.join(', ')}\`\n`;
        }
        
        if (permission.tool?.messageID) {
          const details = await lookupToolDetails(permission.sessionID, permission.tool);
          if (details) {
            if (details.toolName) msg += `Tool: \`${details.toolName}\`\n`;
            if (details.args) msg += `Args: \`${details.args}\`\n`;
          }
        }
        
        msg += `\n*1.* Yes (once)\n*2.* Always\n*3.* No (reject)\n`;
        msg += `\n_Reply: 1/y/yes, 2/always, or 3/n/no_`;
        
        pendingPermission = {
          sessionId: permission.sessionID,
          permissionId: permission.id,
          title: permission.permission,
        };
        
        await sendMessage(msg);
      }
      
      if (event.type === 'session.created') {
        const session = event.properties.info;
        if (session.parentID) {
          subSessionIds.add(session.id);
          if (session.parentID === activeMainSessionId) {
            pendingText.delete(activeMainSessionId);
          }
        }
      }
      
      if (event.type === 'session.idle') {
        const sessionId = event.properties.sessionID;
        
        if (subSessionIds.has(sessionId)) {
          subSessionIds.delete(sessionId);
          pendingText.delete(sessionId);
          return;
        }
        
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

export default OpenCodeConnectPlugin;
export { OpenCodeConnectPlugin };
export type { SlackSyncConfig, SqsIncomingMessage, SqsOutgoingMessage };
