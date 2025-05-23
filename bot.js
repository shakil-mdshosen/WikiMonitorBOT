import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import EventSource from 'eventsource';
import { loadSettings, saveSettings } from './utils/settings.js';
import { updateGithub } from './utils/github.js';

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
    timeout: 10000
  }
});

// Load settings and initialize group status
const settings = loadSettings();
const groupStatus = {};
Object.keys(settings).forEach(chatId => {
  groupStatus[chatId] = settings[chatId].status || 'active'; // Default to active
});

console.log('Loaded settings for groups:', Object.keys(settings).join(', ') || 'none');

// Initialize Wikimedia EventStream
let eventSource;

function connectToEventStream() {
  eventSource = new EventSource(config.eventStreamUrl);

  eventSource.onopen = () => {
    console.log('✅ Connected to Wikimedia EventStream');
  };

  eventSource.onerror = (err) => {
    console.error('❌ EventStream error:', err);
    setTimeout(connectToEventStream, 5000);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const wiki = data.wiki || data.meta?.domain;
      const type = data.type === 'log' ? data.log_type : data.type;

      // Find matching groups that are active
      Object.entries(settings).forEach(([chatId, groupConfig]) => {
        if (groupStatus[chatId] === 'active' && 
            groupConfig.wiki === wiki && 
            groupConfig.events.includes(type)) {
          sendNotification(chatId, data);
        }
      });
    } catch (err) {
      console.error('Error processing event:', err);
    }
  };
}

function sendNotification(chatId, data) {
  const title = data.title || data.log_title || 'Unknown';
  const user = data.user || data.performer?.user_text || 'Anonymous';
  const wikiDomain = (data.wiki || 'enwiki').replace('wiki', '');
  const baseUrl = `https://${wikiDomain}.wikipedia.org`;
  
  // Page URL
  const pageUrl = `${baseUrl}/wiki/${encodeURIComponent(title)}`;
  
  // User contribution link
  const userLink = user !== 'Anonymous' 
    ? `[${user}](${baseUrl}/wiki/Special:Contributions/${encodeURIComponent(user)})`
    : 'Anonymous';

  // Start building the message
  let messageParts = [];
  let eventType = data.type;

  // Handle different event types
  switch (data.type) {
    case 'edit':
      messageParts.push(`✏️ *Edit* on ${data.wiki}`);
      if (data.revid && data.old_revid) {
        const diffUrl = `${baseUrl}/w/index.php?diff=${data.revid}&oldid=${data.old_revid}`;
        messageParts.push(`🔀 [View changes](${diffUrl})`);
      }
      if (data.comment) {
        messageParts.push(`📝 Edit summary: ${data.comment}`);
      }
      break;

    case 'new':
      messageParts.push(`✨ *New page* on ${data.wiki}`);
      if (data.comment) {
        messageParts.push(`📝 Creation reason: ${data.comment}`);
      }
      break;

    case 'log':
      eventType = `log ${data.log_type}`;
      switch (data.log_type) {
        case 'delete':
          messageParts.push(`🗑️ *Page deletion* on ${data.wiki}`);
          if (data.log_params?.count) {
            messageParts.push(`🔢 Pages affected: ${data.log_params.count}`);
          }
          break;
        case 'block':
          messageParts.push(`⛔ *User block* on ${data.wiki}`);
          if (data.log_params?.duration) {
            messageParts.push(`⏱️ Duration: ${data.log_params.duration}`);
          }
          break;
        case 'move':
          messageParts.push(`↔️ *Page move* on ${data.wiki}`);
          if (data.log_params?.target_title) {
            const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.log_params.target_title)}`;
            messageParts.push(`➡️ Moved to: [${data.log_params.target_title}](${targetUrl})`);
          }
          break;
        case 'protect':
          messageParts.push(`🛡️ *Protection change* on ${data.wiki}`);
          if (data.log_params?.description) {
            messageParts.push(`📝 Reason: ${data.log_params.description}`);
          }
          break;
        default:
          messageParts.push(`📋 *Log event (${data.log_type})* on ${data.wiki}`);
      }
      if (data.log_comment) {
        messageParts.push(`💬 Log comment: ${data.log_comment}`);
      }
      break;

    case 'move':
      messageParts.push(`↔️ *Page move* on ${data.wiki}`);
      if (data.target_title) {
        const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.target_title)}`;
        messageParts.push(`➡️ Moved to: [${data.target_title}](${targetUrl})`);
      }
      if (data.comment) {
        messageParts.push(`📝 Reason: ${data.comment}`);
      }
      break;

    default:
      messageParts.push(`🔔 *${data.type}* on ${data.wiki}`);
  }

  // Common message parts for all events
  messageParts.push(
    `📄 Page: [${title}](${pageUrl})`,
    `👤 User: ${userLink}`
  );

  // For edits, show byte changes if available
  if (data.type === 'edit' && data.length && data.old_length) {
    const byteChange = data.length.new - data.length.old;
    const changeSymbol = byteChange >= 0 ? '+' : '';
    messageParts.push(`📊 Size change: ${changeSymbol}${byteChange} bytes`);
  }

  // For new pages, show initial size if available
  if (data.type === 'new' && data.length) {
    messageParts.push(`📊 Initial size: ${data.length.new} bytes`);
  }

  // Send the formatted message
  bot.sendMessage(chatId, messageParts.join('\n'), {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  }).catch(err => {
    console.error(`Failed to send to group ${chatId}:`, err.message);
  });
}

// Command handlers with suggestions
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

// Set bot commands
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

bot.onText(/\/setwiki (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, '🚫 *Error:* This command is only available for admins', 
      { parse_mode: 'Markdown' });
  }

  const wiki = match[1].trim();
  
  // Validate wiki format (e.g. enwiki, bnwiki)
  if (!wiki.match(/^[a-z]{2,}wiki$/)) {
    return bot.sendMessage(chatId, 
      '⚠️ *Invalid wiki format.* Please use format like "enwiki", "bnwiki" etc.',
      { parse_mode: 'Markdown' });
  }

  // Initialize group config if not exists
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
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/setevents (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, '🚫 *Error:* This command is only available for admins', 
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
  
  // Verify we have a wiki set first
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

bot.onText(/\/off/, (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, '🚫 *Error:* This command is only available for admins', 
      { parse_mode: 'Markdown' });
  }

  groupStatus[chatId] = 'paused';
  
  // Update settings with status
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
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/on/, (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, '🚫 *Error:* This command is only available for admins', 
      { parse_mode: 'Markdown' });
  }

  groupStatus[chatId] = 'active';
  
  // Update settings with status
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
    });
  } else {
    bot.sendMessage(chatId, 
      '❌ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

// Admin check function
function isAdmin(userId) {
  // Allow all users if no admin IDs specified
  if (config.adminIds.length === 0) return true;
  return config.adminIds.includes(userId.toString());
}

// Start the bot
connectToEventStream();
console.log('🤖 Bot is running and ready for commands...');

// Cleanup on exit
process.on('SIGINT', () => {
  eventSource?.close();
  console.log('🛑 Bot shutting down...');
  process.exit();
});
