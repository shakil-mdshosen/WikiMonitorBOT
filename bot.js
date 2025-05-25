import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import EventSource from 'eventsource';
import { loadSettings, saveSettings } from './utils/settings.js';
import { updateGithub } from './utils/github.js';
import { isBotAccount } from './utils/botCheck.js';
import { notifyError, notifyConfigChange, notifySystemEvent } from './utils/notifier.js';

// Configuration
const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  eventStreamUrl: 'https://stream.wikimedia.org/v2/stream/recentchange',
  adminIds: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : []
};

// Initialize bot with polling
const bot = new TelegramBot(config.telegramToken, {
  polling: true,
  request: {
    timeout: 20000
  }
});

// Load settings and initialize group status
const settings = loadSettings();
const groupStatus = {};
Object.keys(settings).forEach(chatId => {
  groupStatus[chatId] = settings[chatId].status || 'active';
});

console.log('Loaded settings for groups:', Object.keys(settings).join(', ') || 'none');

// Event deduplication tracking
const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 1000;

// Initialize Wikimedia EventStream
let eventSource;

function getWikiBaseUrl(wiki) {
  if (wiki === 'commonswiki') {
    return 'https://commons.wikimedia.org';
  }
  if (wiki === 'wikidatawiki') {
    return 'https://www.wikidata.org';
  }
  
  const matches = wiki.match(/^([a-z]{2,})(wikibooks|wiktionary|wikinews|wikiquote|wikisource|wikiversity|wikivoyage|wikimedia|wiki)$/i);
  
  if (!matches) {
    console.warn(`Unknown wiki format: ${wiki}, defaulting to Wikipedia`);
    return `https://${wiki.replace('wiki', '')}.wikipedia.org`;
  }
  
  const [, lang, project] = matches;
  
  if (project && project !== 'wiki') {
    return `https://${lang}.${project}.org`;
  }
  
  return `https://${lang}.wikipedia.org`;
}

async function isAdmin(bot, chatId, userId) {
  // Always allow in private chats
  if (chatId > 0) return true;
  
  // Check if user is in adminIds from config
  if (config.adminIds.includes(userId.toString())) return true;
  
  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(admin => admin.user.id.toString() === userId.toString());
  } catch (err) {
    console.error(`Failed to check admin status for ${userId} in ${chatId}:`, err);
    notifyError(err, `Failed to check admin status for ${userId} in ${chatId}`);
    return false;
  }
}

function connectToEventStream() {
  eventSource = new EventSource(config.eventStreamUrl);

  eventSource.onopen = () => {
    console.log('✅ Connected to Wikimedia EventStream');
    notifySystemEvent('EventStream Connected', 'Successfully connected to Wikimedia EventStream');
  };

  eventSource.onerror = (err) => {
    console.error('❌ EventStream error:', err);
    
    // Extract the Retry-After header from the error if available
    let retryAfter = 5; // default 5 seconds for 429 errors
    if (err.event?.target?.responseHeaders?.['retry-after']) {
      retryAfter = parseInt(err.event.target.responseHeaders['retry-after']);
    } else if (err.status === 429) {
      // If we get a 429 without Retry-After, use default
      retryAfter = 5;
    } else {
      // For non-429 errors, use shorter 2s delay
      retryAfter = 2;
    }

    // Calculate delay with some randomness to avoid thundering herd
    const retryDelay = Math.min(
      60000, // Maximum 60 second delay
      Math.max(
        1000, // Minimum 1 second delay
        retryAfter * 1000 + Math.random() * 2000 // Add up to 2s jitter
      )
    );

    notifyError(err, `EventStream connection error. Retrying in ${Math.ceil(retryDelay/1000)}s`);
    
    setTimeout(() => {
      connectToEventStream();
    }, retryDelay);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Skip events from bot accounts
      if (isBotAccount(data)) {
        return;
      }

      const eventId = `${data.meta?.dt || Date.now()}-${data.wiki}-${data.title}-${data.type}-${data.user || data.performer?.user_text || ''}`;
      
      if (processedEvents.has(eventId)) return;
      
      processedEvents.add(eventId);
      if (processedEvents.size > MAX_PROCESSED_EVENTS) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
      }

      const wiki = data.wiki || data.meta?.domain;
      const type = data.type === 'log' ? data.log_type : data.type;

      Object.entries(settings).forEach(([chatId, groupConfig]) => {
        if (groupStatus[chatId] === 'active' && 
            groupConfig.wiki === wiki && 
            groupConfig.events.includes(type)) {
          sendNotification(chatId, data);
        }
      });
    } catch (err) {
      console.error('Error processing event:', err);
      notifyError(err, 'Error processing EventStream message');
    }
  };
}

function sendNotification(chatId, data) {
  const title = data.title || data.log_title || 'Unknown';
  const user = data.user || data.performer?.user_text || 'Anonymous';
  const wiki = data.wiki || 'enwiki';
  const baseUrl = getWikiBaseUrl(wiki);
  const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
  const pageUrl = `${baseUrl}/wiki/${encodedTitle}`;
  const userLink = user !== 'Anonymous' 
    ? `[${user}](${baseUrl}/wiki/Special:Contributions/${encodeURIComponent(user)})`
    : 'Anonymous';

  let messageParts = [];
  let eventType = data.type;

  switch (data.type) {
    case 'edit':
      messageParts.push(`✏️ *Edit* on ${wiki}`);
      if (data.revid && data.old_revid) {
        const diffUrl = `${baseUrl}/w/index.php?diff=${data.revid}&oldid=${data.old_revid}`;
        messageParts.push(`🔀 [View changes](${diffUrl})`);
      }
      if (data.comment) {
        messageParts.push(`📝 Edit summary: ${data.comment}`);
      }
      break;
    case 'new':
      messageParts.push(`✨ *New page* on ${wiki}`);
      if (data.comment) {
        messageParts.push(`📝 Creation reason: ${data.comment}`);
      }
      break;
    case 'log':
      eventType = `log ${data.log_type}`;
      switch (data.log_type) {
        case 'delete':
          messageParts.push(`🗑️ *Page deletion* on ${wiki}`);
          if (data.log_params?.count) {
            messageParts.push(`🔢 Pages affected: ${data.log_params.count}`);
          }
          break;
        case 'block':
          messageParts.push(`⛔ *User block* on ${wiki}`);
          if (data.log_params?.duration) {
            messageParts.push(`⏱️ Duration: ${data.log_params.duration}`);
          }
          break;
        case 'move':
          messageParts.push(`↔️ *Page move* on ${wiki}`);
          if (data.log_params?.target_title) {
            const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.log_params.target_title.replace(/ /g, '_'))}`;
            messageParts.push(`➡️ Moved to: [${data.log_params.target_title}](${targetUrl})`);
          }
          break;
        case 'protect':
          messageParts.push(`🛡️ *Protection change* on ${wiki}`);
          if (data.log_params?.description) {
            messageParts.push(`📝 Reason: ${data.log_params.description}`);
          }
          break;
        default:
          messageParts.push(`📋 *Log event (${data.log_type})* on ${wiki}`);
      }
      if (data.log_comment) {
        messageParts.push(`💬 Log comment: ${data.log_comment}`);
      }
      break;
    case 'move':
      messageParts.push(`↔️ *Page move* on ${wiki}`);
      if (data.target_title) {
        const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.target_title.replace(/ /g, '_'))}`;
        messageParts.push(`➡️ Moved to: [${data.target_title}](${targetUrl})`);
      }
      if (data.comment) {
        messageParts.push(`📝 Reason: ${data.comment}`);
      }
      break;
    default:
      messageParts.push(`🔔 *${data.type}* on ${wiki}`);
  }

  messageParts.push(
    `📄 Page: [${title}](${pageUrl})`,
    `👤 User: ${userLink}`
  );

  if (data.type === 'edit' && data.length && data.old_length) {
    const byteChange = data.length.new - data.length.old;
    const changeSymbol = byteChange >= 0 ? '+' : '';
    messageParts.push(`📊 Size change: ${changeSymbol}${byteChange} bytes`);
  }

  if (data.type === 'new' && data.length) {
    messageParts.push(`📊 Initial size: ${data.length.new} bytes`);
  }

  bot.sendMessage(chatId, messageParts.join('\n'), {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  }).catch(err => {
    console.error(`Failed to send to group ${chatId}:`, err.message);
    notifyError(err, `Failed to send message to group ${chatId}`);
  });
}

const commands = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'Show help information' },
  { command: 'setwiki', description: 'Set wiki to monitor (e.g. enwiki)' },
  { command: 'setevents', description: 'Set event types (edit, new, delete)' },
  { command: 'showconfig', description: 'Show current configuration' },
  { command: 'status', description: 'Check bot status in this group' },
  { command: 'off', description: 'Pause notifications in this group' },
  { command: 'on', description: 'Resume notifications in this group' }
];

bot.setMyCommands(commands);

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMsg = `👋 *Welcome to Wikimedia Monitor Bot!*\n\n` +
    `I monitor Wikimedia events and notify this group about changes.\n\n` +
    `*Available commands:*\n` +
    `${commands.map(cmd => `/${cmd.command} - ${cmd.description}`).join('\n')}\n\n` +
    `Example setup:\n` +
    `1. /setwiki enwiki\n` +
    `2. /setevents edit new delete move\n` +
    `3. Use /off to pause or /on to resume notifications`;
  
  bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `ℹ️ *Help Menu*\n\n` +
    `*Available commands:*\n` +
    `${commands.map(cmd => `/${cmd.command} - ${cmd.description}`).join('\n')}\n\n` +
    `*Supported event types:*\n` +
    `- edit: Page edits\n` +
    `- new: New page creations\n` +
    `- delete: Page deletions\n` +
    `- move: Page moves\n` +
    `- block: User blocks\n` +
    `- protect: Page protections\n` +
    `- log: All log events`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/setwiki (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, '🚫 *Error:* Only group admins can change settings', 
      { parse_mode: 'Markdown' });
  }

  const wiki = match[1].trim();
  
  if (!wiki.match(/^[a-z]{2,}(wiki|wikibooks|wiktionary|wikinews|wikiquote|wikisource|wikiversity|wikivoyage)$/)) {
    return bot.sendMessage(chatId, 
      '⚠️ *Invalid wiki format.* Please use format like "enwiki", "bnwikibooks" etc.',
      { parse_mode: 'Markdown' });
  }

  if (!settings[chatId]) {
    settings[chatId] = { wiki: '', events: [], status: 'active' };
  }
  
  settings[chatId].wiki = wiki;
  groupStatus[chatId] = 'active';
  
  if (saveSettings(settings)) {
    updateGithub(settings).then(success => {
      const statusMsg = success ? 'and synced with GitHub' : 'but GitHub sync failed';
      bot.sendMessage(chatId, 
        `✅ *Success!* Wiki set to \`${wiki}\` ${statusMsg}. ` +
        `Now set events with /setevents`,
        { parse_mode: 'Markdown' });
      notifyConfigChange({
        chatId,
        userId: fromId,
        username: msg.from.username,
        action: 'setwiki',
        changes: { wiki }
      });
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/setevents (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, '🚫 *Error:* Only group admins can change settings', 
      { parse_mode: 'Markdown' });
  }

  const events = match[1].trim().split(/\s+/);
  const validEvents = ['edit', 'new', 'delete', 'move', 'block', 'protect', 'log'];
  const invalidEvents = events.filter(e => !validEvents.includes(e));
  
  if (invalidEvents.length > 0) {
    return bot.sendMessage(chatId,
      `⚠️ *Invalid event types:* ${invalidEvents.join(', ')}\n\n` +
      `Valid events: ${validEvents.join(', ')}`,
      { parse_mode: 'Markdown' });
  }
  
  if (!settings[chatId]?.wiki) {
    return bot.sendMessage(chatId, 
      '⚠️ *Error:* Please set a wiki first with /setwiki',
      { parse_mode: 'Markdown' });
  }
  
  settings[chatId].events = events;
  
  if (saveSettings(settings)) {
    updateGithub(settings).then(success => {
      const statusMsg = success ? 'and synced with GitHub' : 'but GitHub sync failed';
      bot.sendMessage(chatId,
        `✅ *Success!* Events set to: \`${events.join(', ')}\` ${statusMsg}`,
        { parse_mode: 'Markdown' });
      notifyConfigChange({
        chatId,
        userId: fromId,
        username: msg.from.username,
        action: 'setevents',
        changes: { events }
      });
    });
  } else {
    bot.sendMessage(chatId,
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/showconfig/, (msg) => {
  const chatId = msg.chat.id.toString();
  const groupConfig = settings[chatId] || {};
  const status = groupStatus[chatId] || 'active';
  
  const message = `
🔧 *Current Configuration:*
Wiki: \`${groupConfig.wiki || 'Not set'}\`
Events: \`${groupConfig.events?.join(', ') || 'None'}\`
Status: \`${status === 'active' ? 'Active ✅' : 'Paused ⏸'}\`
  `.trim();
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id.toString();
  const currentStatus = groupStatus[chatId] || 'active';
  
  bot.sendMessage(chatId, 
    `🔘 Current status: ${currentStatus === 'active' ? '✅ Active' : '⏸ Paused'}\n` +
    `Use /off to pause or /on to resume notifications.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/off/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, '🚫 *Error:* Only group admins can pause notifications', 
      { parse_mode: 'Markdown' });
  }

  groupStatus[chatId] = 'paused';
  
  if (!settings[chatId]) {
    settings[chatId] = { status: 'paused' };
  } else {
    settings[chatId].status = 'paused';
  }
  
  if (saveSettings(settings)) {
    updateGithub(settings).then(success => {
      const statusMsg = success ? 'and synced with GitHub' : 'but GitHub sync failed';
      bot.sendMessage(chatId, 
        `⏸ *Notifications paused* ${statusMsg}. Use /on to resume.`,
        { parse_mode: 'Markdown' });
      notifyConfigChange({
        chatId,
        userId: fromId,
        username: msg.from.username,
        action: 'pause',
        changes: { status: 'paused' }
      });
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/on/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, '🚫 *Error:* Only group admins can resume notifications', 
      { parse_mode: 'Markdown' });
  }

  groupStatus[chatId] = 'active';
  
  if (!settings[chatId]) {
    settings[chatId] = { status: 'active' };
  } else {
    settings[chatId].status = 'active';
  }
  
  if (saveSettings(settings)) {
    updateGithub(settings).then(success => {
      const statusMsg = success ? 'and synced with GitHub' : 'but GitHub sync failed';
      bot.sendMessage(chatId, 
        `✅ *Notifications resumed* ${statusMsg}. Use /off to pause.`,
        { parse_mode: 'Markdown' });
      notifyConfigChange({
        chatId,
        userId: fromId,
        username: msg.from.username,
        action: 'resume',
        changes: { status: 'active' }
      });
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

// Start the bot
connectToEventStream();
console.log('🤖 Bot is running and ready for commands...');

// Cleanup on exit
process.on('SIGINT', () => {
  eventSource?.close();
  notifySystemEvent('Bot Shutdown', 'Bot is shutting down');
  console.log('🛑 Bot shutting down...');
  process.exit();
});
