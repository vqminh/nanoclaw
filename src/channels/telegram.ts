import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Telegram Bot API types (minimal subset)
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string; mime_type?: string };
  sticker?: { emoji?: string };
  voice?: unknown;
  video?: unknown;
  audio?: unknown;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

interface TgApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatName(chat: TgChat): string {
  if (chat.title) return chat.title;
  const parts = [chat.first_name, chat.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (chat.username) return `@${chat.username}`;
  return `tg:${chat.id}`;
}

function senderName(from: TgUser): string {
  const parts = [from.first_name, from.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (from.username) return `@${from.username}`;
  return String(from.id);
}

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

export class TelegramChannel implements Channel {
  name = 'telegram';

  private token: string;
  private opts: ChannelOpts;
  private polling = false;
  private offset = 0;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private botUsername: string | null = null;

  constructor(token: string, opts: ChannelOpts) {
    this.token = token;
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // Telegram API wrapper
  // -------------------------------------------------------------------------

  private async apiCall<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as TgApiResponse<T>;
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed: ${data.description}`);
    }
    return data.result;
  }

  // -------------------------------------------------------------------------
  // Channel interface
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const me = await this.apiCall<TgUser>('getMe');
    this.botUsername = me.username ?? null;
    this.polling = true;

    console.log(`\n  Telegram bot: @${me.username} (id=${me.id})`);
    console.log(
      `  Add the bot to a group or start a DM, then use /chatid to get the JID\n`,
    );

    this.pollLoop();
  }

  private pollLoop(): void {
    if (!this.polling) return;

    this.apiCall<TgUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message', 'edited_message'],
    })
      .then((updates) => {
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message ?? update.edited_message;
          if (msg) this.handleMessage(msg);
        }
        this.pollTimeout = setTimeout(() => this.pollLoop(), 100);
      })
      .catch((err) => {
        logger.warn(
          { err: err.message },
          'Telegram poll error, retrying in 5s',
        );
        this.pollTimeout = setTimeout(() => this.pollLoop(), 5000);
      });
  }

  private handleMessage(msg: TgMessage): void {
    let content = msg.text ?? msg.caption ?? '';

    if (!content) {
      if (msg.photo) content = '[Photo]';
      else if (msg.document)
        content = `[Document: ${msg.document.file_name ?? 'file'}]`;
      else if (msg.sticker)
        content = `[Sticker${msg.sticker.emoji ? ': ' + msg.sticker.emoji : ''}]`;
      else if (msg.voice) content = '[Voice message]';
      else if (msg.video) content = '[Video]';
      else if (msg.audio) content = '[Audio]';
      else return;
    }

    const chatId = msg.chat.id;
    const chatJid = `tg:${chatId}`;
    const timestamp = new Date(msg.date * 1000).toISOString();
    const name = chatName(msg.chat);
    const isGroup = msg.chat.type !== 'private';

    this.opts.onChatMetadata(chatJid, timestamp, name, 'telegram', isGroup);

    const from = msg.from;
    const sender = from ? String(from.id) : 'unknown';
    const sender_name = from ? senderName(from) : 'Unknown';

    // Handle /chatid command
    if (content.trim() === '/chatid') {
      this.sendMessage(chatJid, `Chat JID: tg:${chatId}`).catch(() => {});
      return;
    }

    // For group chats, only respond when trigger matches or bot is @mentioned
    if (isGroup) {
      const botMention = this.botUsername ? `@${this.botUsername}` : null;
      const hasMention = botMention ? content.includes(botMention) : false;

      if (!hasMention && !TRIGGER_PATTERN.test(content)) {
        return;
      }

      // Strip bot @mention from content
      if (botMention) {
        content = content.replace(botMention, '').trim();
      }

      // Ensure trigger prefix is present
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(chatJid, {
      id: String(msg.message_id),
      chat_jid: chatJid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: msg.from?.is_bot ?? false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;

    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: text.slice(i, i + MAX_LENGTH),
      });
    }

    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const chatId = jid.replace(/^tg:/, '');
    try {
      await this.apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing action');
    }
  }

  isConnected(): boolean {
    return this.polling;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    logger.info('Telegram bot stopped');
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set — channel disabled');
    return null;
  }
  return new TelegramChannel(token, opts);
});
