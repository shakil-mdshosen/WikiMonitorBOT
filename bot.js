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

// Load settings
const settings = loadSettings();
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

      // Find matching groups
      Object.entries(settings).forEach(([chatId, groupConfig]) => {
        if (groupConfig.wiki === wiki && groupConfig.events.includes(type)) {
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
  const pageUrl = `https://${wikiDomain}.wikipedia.org/wiki/${encodeURIComponent(title)}`;

  const message = `
🔔 *${data.type.toUpperCase()}* on ${data.wiki}
📝 Page: [${title}](${pageUrl})
👤 User: ${user}
  `.trim();

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  }).catch(err => {
    console.error(`Failed to send to group ${chatId}:`, err.message);
  });
}

// Command handlers
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '👋 Welcome to Wikimedia Monitor Bot!\n\n' +
    'Available commands:\n' +
    '/setwiki <wiki> - Set wiki to monitor (e.g. enwiki)\n' +
    '/setevents <types> - Set event types (edit, new, delete, etc.)\n' +
    '/showconfig - Show current configuration\n' +
    '/help - Show help message'
  );
});

bot.onText(/\/setwiki (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, '🚫 This command is only available for admins');
  }

  const wiki = match[1].trim();
  
  // Initialize group config if not exists
  if (!settings[chatId]) {
    settings[chatId] = { wiki: '', events: [] };
  }
  
  settings[chatId].wiki = wiki;
  saveSettings(settings);
  updateGithub(settings);
  
  bot.sendMessage(chatId, `✅ Wiki set to: \`${wiki}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/setevents (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, '🚫 This command is only available for admins');
  }

  const events = match[1].trim().split(/\s+/);
  
  // Verify we have a wiki set first
  if (!settings[chatId]?.wiki) {
    return bot.sendMessage(chatId, '⚠️ Please set a wiki first with /setwiki');
  }
  
  settings[chatId].events = events;
  saveSettings(settings);
  updateGithub(settings);
  
  bot.sendMessage(chatId, `✅ Events set to: \`${events.join(', ')}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/showconfig/, (msg) => {
  const chatId = msg.chat.id.toString();
  const groupConfig = settings[chatId] || {};
  
  const message = `
🔧 *Current Configuration:*
Wiki: \`${groupConfig.wiki || 'Not set'}\`
Events: \`${groupConfig.events?.join(', ') || 'None'}\`
  `.trim();
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'ℹ️ *Help Menu*\n\n' +
    'This bot monitors Wikimedia events and sends notifications to this group.\n\n' +
    '*Commands:*\n' +
    '/setwiki <wiki> - Set wiki to monitor (e.g. enwiki)\n' +
    '/setevents <types> - Set event types (edit, new, delete, etc.)\n' +
    '/showconfig - Show current configuration\n' +
    '/help - Show this message\n\n' +
    'Example setup:\n' +
    '1. /setwiki enwiki\n' +
    '2. /setevents edit new delete',
    { parse_mode: 'Markdown' }
  );
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
