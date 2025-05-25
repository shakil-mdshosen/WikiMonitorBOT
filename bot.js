import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import EventSource from 'eventsource';
import { loadSettings, saveSettings } from './utils/settings.js';
import { updateGithub } from './utils/github.js';
import { isBotAccount } from './utils/botCheck.js';

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

// Rate limiting and queueing
const RATE_LIMIT_DELAY = 2000; // 2 seconds between messages
const messageQueue = new Map();

// Connection monitoring
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60000;
let lastEventTime = Date.now();
const stats = {
  connections: 0,
  errors: 0,
  events: 0,
  skippedBots: 0
};

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
  if (chatId > 0) return true;
  if (config.adminIds.includes(userId.toString())) return true;
  
  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(admin => admin.user.id.toString() === userId.toString());
  } catch (err) {
    console.error(`Failed to check admin status for ${userId} in ${chatId}:`, err);
    return false;
  }
}

function connectToEventStream() {
  eventSource = new EventSource(config.eventStreamUrl);
  stats.connections++;

  eventSource.onopen = () => {
    console.log('✅ Connected to Wikimedia EventStream');
    reconnectDelay = 1000;
  };

  eventSource.onerror = (err) => {
    stats.errors++;
    console.error(`❌ EventStream error (Status: ${err.status}):`, err.type);
    eventSource.close();
    
    const delay = Math.min(reconnectDelay + Math.random() * 1000, MAX_RECONNECT_DELAY);
    console.log(`⏳ Reconnecting in ${Math.round(delay/1000)} seconds...`);
    
    setTimeout(() => {
      reconnectDelay *= 2;
      connectToEventStream();
    }, delay);
  };

  eventSource.onmessage = (event) => {
    try {
      lastEventTime = Date.now();
      const data = JSON.parse(event.data);
      stats.events++;

      if (isBotAccount(data)) {
        stats.skippedBots++;
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
    }
  };
}

function sendNotification(chatId, data) {
  if (!messageQueue.has(chatId)) {
    messageQueue.set(chatId, []);
  }
  
  messageQueue.get(chatId).push(data);
  
  if (messageQueue.get(chatId).length === 1) {
    processQueue(chatId);
  }
}

async function processQueue(chatId) {
  const queue = messageQueue.get(chatId);
  if (!queue || queue.length === 0) return;
  
  const data = queue[0];
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

  try {
    await bot.sendMessage(chatId, messageParts.join('\n'), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    
    queue.shift();
    setTimeout(() => processQueue(chatId), RATE_LIMIT_DELAY);
  } catch (err) {
    console.error(`Failed to send to group ${chatId}:`, err.message);
    setTimeout(() => processQueue(chatId), 5000);
  }
}

// Connection health monitoring
setInterval(() => {
  if (Date.now() - lastEventTime > 120000) {
    console.log('🕒 No events received in 2 minutes, reconnecting...');
    eventSource?.close();
    connectToEventStream();
  }
}, 60000);

const commands = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'Show help information' },
  { command: 'setwiki', description: 'Set wiki to monitor (e.g. enwiki)' },
  { command: 'setevents', description: 'Set event types (edit, new, delete)' },
  { command: 'showconfig', description: 'Show current configuration' },
  { command: 'status', description: 'Check bot status in this group' },
  { command: 'off', description: 'Pause notifications in this group' },
  { command: 'on', description: 'Resume notifications in this group' },
  { command: 'stats', description: 'Show bot statistics' }
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

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `📊 *Bot Statistics*\n` +
    `Connections: ${stats.connections}\n` +
    `Events Processed: ${stats.events}\n` +
    `Skipped Bot Events: ${stats.skippedBots}\n` +
    `Errors: ${stats.errors}\n` +
    `Queue Sizes: ${Array.from(messageQueue.entries())
      .map(([id, q]) => `${id}: ${q.length}`)
      .join(', ') || 'None'}`,
    { parse_mode: 'Markdown' }
  );
});

// ... [keep all other command handlers unchanged] ...

// Start the bot
connectToEventStream();
console.log('🤖 Bot is running and ready for commands...');

// Cleanup on exit
process.on('SIGINT', () => {
  eventSource?.close();
  console.log('🛑 Bot shutting down...');
  process.exit();
});
