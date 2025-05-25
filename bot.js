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
    return false;
  }
}

function connectToEventStream() {
  eventSource = new EventSource(config.eventStreamUrl);

  eventSource.onopen = () => {
    console.log('âœ… Connected to Wikimedia EventStream');
  };

  eventSource.onerror = (err) => {
    console.error('âŒ EventStream error:', err);
    setTimeout(connectToEventStream, 5000);
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
      messageParts.push(`âœï¸ *Edit* on ${wiki}`);
      if (data.revid && data.old_revid) {
        const diffUrl = `${baseUrl}/w/index.php?diff=${data.revid}&oldid=${data.old_revid}`;
        messageParts.push(`ðŸ”€ [View changes](${diffUrl})`);
      }
      if (data.comment) {
        messageParts.push(`ðŸ“ Edit summary: ${data.comment}`);
      }
      break;
    case 'new':
      messageParts.push(`âœ¨ *New page* on ${wiki}`);
      if (data.comment) {
        messageParts.push(`ðŸ“ Creation reason: ${data.comment}`);
      }
      break;
    case 'log':
      eventType = `log ${data.log_type}`;
      switch (data.log_type) {
        case 'delete':
          messageParts.push(`ðŸ—‘ï¸ *Page deletion* on ${wiki}`);
          if (data.log_params?.count) {
            messageParts.push(`ðŸ”¢ Pages affected: ${data.log_params.count}`);
          }
          break;
        case 'block':
          messageParts.push(`â›” *User block* on ${wiki}`);
          if (data.log_params?.duration) {
            messageParts.push(`â±ï¸ Duration: ${data.log_params.duration}`);
          }
          break;
        case 'move':
          messageParts.push(`â†”ï¸ *Page move* on ${wiki}`);
          if (data.log_params?.target_title) {
            const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.log_params.target_title.replace(/ /g, '_'))}`;
            messageParts.push(`âž¡ï¸ Moved to: [${data.log_params.target_title}](${targetUrl})`);
          }
          break;
        case 'protect':
          messageParts.push(`ðŸ›¡ï¸ *Protection change* on ${wiki}`);
          if (data.log_params?.description) {
            messageParts.push(`ðŸ“ Reason: ${data.log_params.description}`);
          }
          break;
        default:
          messageParts.push(`ðŸ“‹ *Log event (${data.log_type})* on ${wiki}`);
      }
      if (data.log_comment) {
        messageParts.push(`ðŸ’¬ Log comment: ${data.log_comment}`);
      }
      break;
    case 'move':
      messageParts.push(`â†”ï¸ *Page move* on ${wiki}`);
      if (data.target_title) {
        const targetUrl = `${baseUrl}/wiki/${encodeURIComponent(data.target_title.replace(/ /g, '_'))}`;
        messageParts.push(`âž¡ï¸ Moved to: [${data.target_title}](${targetUrl})`);
      }
      if (data.comment) {
        messageParts.push(`ðŸ“ Reason: ${data.comment}`);
      }
      break;
    default:
      messageParts.push(`ðŸ”” *${data.type}* on ${wiki}`);
  }

  messageParts.push(
    `ðŸ“„ Page: [${title}](${pageUrl})`,
    `ðŸ‘¤ User: ${userLink}`
  );

  if (data.type === 'edit' && data.length && data.old_length) {
    const byteChange = data.length.new - data.length.old;
    const changeSymbol = byteChange >= 0 ? '+' : '';
    messageParts.push(`ðŸ“Š Size change: ${changeSymbol}${byteChange} bytes`);
  }

  if (data.type === 'new' && data.length) {
    messageParts.push(`ðŸ“Š Initial size: ${data.length.new} bytes`);
  }

  bot.sendMessage(chatId, messageParts.join('\n'), {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  }).catch(err => {
    console.error(`Failed to send to group ${chatId}:`, err.message);
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
  const welcomeMsg = `ðŸ‘‹ *Welcome to Wikimedia Monitor Bot!*\n\n` +
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
    `â„¹ï¸ *Help Menu*\n\n` +
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
    return bot.sendMessage(chatId, 'ðŸš« *Error:* Only group admins can change settings', 
      { parse_mode: 'Markdown' });
  }

  const wiki = match[1].trim();
  
  if (!wiki.match(/^[a-z]{2,}(wiki|wikibooks|wiktionary|wikinews|wikiquote|wikisource|wikiversity|wikivoyage)$/)) {
    return bot.sendMessage(chatId, 
      'âš ï¸ *Invalid wiki format.* Please use format like "enwiki", "bnwikibooks" etc.',
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
        `âœ… *Success!* Wiki set to \`${wiki}\` ${statusMsg}. ` +
        `Now set events with /setevents`,
        { parse_mode: 'Markdown' });
    });
  } else {
    bot.sendMessage(chatId, 
      'âŒ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/setevents (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, 'ðŸš« *Error:* Only group admins can change settings', 
      { parse_mode: 'Markdown' });
  }

  const events = match[1].trim().split(/\s+/);
  const validEvents = ['edit', 'new', 'delete', 'move', 'block', 'protect', 'log'];
  const invalidEvents = events.filter(e => !validEvents.includes(e));
  
  if (invalidEvents.length > 0) {
    return bot.sendMessage(chatId,
      `âš ï¸ *Invalid event types:* ${invalidEvents.join(', ')}\n\n` +
      `Valid events: ${validEvents.join(', ')}`,
      { parse_mode: 'Markdown' });
  }
  
  if (!settings[chatId]?.wiki) {
    return bot.sendMessage(chatId, 
      'âš ï¸ *Error:* Please set a wiki first with /setwiki',
      { parse_mode: 'Markdown' });
  }
  
  settings[chatId].events = events;
  
  if (saveSettings(settings)) {
    updateGithub(settings).then(success => {
      const statusMsg = success ? 'and synced with GitHub' : 'but GitHub sync failed';
      bot.sendMessage(chatId,
        `âœ… *Success!* Events set to: \`${events.join(', ')}\` ${statusMsg}`,
        { parse_mode: 'Markdown' });
    });
  } else {
    bot.sendMessage(chatId,
      'âŒ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/showconfig/, (msg) => {
  const chatId = msg.chat.id.toString();
  const groupConfig = settings[chatId] || {};
  const status = groupStatus[chatId] || 'active';
  
  const message = `
ðŸ”§ *Current Configuration:*
Wiki: \`${groupConfig.wiki || 'Not set'}\`
Events: \`${groupConfig.events?.join(', ') || 'None'}\`
Status: \`${status === 'active' ? 'Active âœ…' : 'Paused â¸'}\`
  `.trim();
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id.toString();
  const currentStatus = groupStatus[chatId] || 'active';
  
  bot.sendMessage(chatId, 
    `ðŸ”˜ Current status: ${currentStatus === 'active' ? 'âœ… Active' : 'â¸ Paused'}\n` +
    `Use /off to pause or /on to resume notifications.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/off/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, 'ðŸš« *Error:* Only group admins can pause notifications', 
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
        `â¸ *Notifications paused* ${statusMsg}. Use /on to resume.`,
        { parse_mode: 'Markdown' });
    });
  } else {
    bot.sendMessage(chatId, 
      'âŒ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/on/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const fromId = msg.from.id.toString();
  
  if (!(await isAdmin(bot, chatId, fromId))) {
    return bot.sendMessage(chatId, 'ðŸš« *Error:* Only group admins can resume notifications', 
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
        `âœ… *Notifications resumed* ${statusMsg}. Use /off to pause.`,
        { parse_mode: 'Markdown' });
    });
  } else {
    bot.sendMessage(chatId, 
      'âŒ *Error:* Failed to save settings. Please try again.',
      { parse_mode: 'Markdown' });
  }
});

// Start the bot
connectToEventStream();
console.log('ðŸ¤– Bot is running and ready for commands...');

// Cleanup on exit
process.on('SIGINT', () => {
  eventSource?.close();
  console.log('ðŸ›‘ Bot shutting down...');
  process.exit();
});
