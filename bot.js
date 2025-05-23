require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const WikimediaStream = require('wikimedia-streams');
const { loadSettings, saveSettings } = require('./utils/settings');
const { updateGithub } = require('./utils/github');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const settings = loadSettings();

// Initialize Wikimedia stream
const stream = new WikimediaStream('recentchange');

stream.on('open', () => console.log('✅ Connected to Wikimedia stream'));
stream.on('error', err => console.error('❌ Stream error:', err));

stream.on('data', data => {
  const wiki = data.wiki || data.meta?.domain;
  const type = data.type === 'log' ? data.log_type : data.type;
  
  Object.entries(settings).forEach(([chatId, config]) => {
    if (config.wiki === wiki && config.events.includes(type)) {
      sendNotification(chatId, data);
    }
  });
});

function sendNotification(chatId, data) {
  const title = data.title || data.log_title || 'Unknown';
  const user = data.user || data.performer?.user_text || 'Anonymous';
  const wikiDomain = (data.wiki || 'enwiki').replace('wiki', '');
  const pageUrl = `https://${wikiDomain}.wikipedia.org/wiki/${encodeURIComponent(title)}`;

  bot.sendMessage(chatId, 
    `🔔 *${data.type.toUpperCase()}* on ${data.wiki}\n` +
    `📝 Page: [${title}](${pageUrl})\n` +
    `👤 User: ${user}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  ).catch(err => console.error(`Error sending to ${chatId}:`, err.message));
}

// Command handlers
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, '👋 Welcome! Use /setwiki and /setevents to configure monitoring.');
});

bot.onText(/\/setwiki (.+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  
  const chatId = msg.chat.id.toString();
  settings[chatId] = settings[chatId] || { events: [] };
  settings[chatId].wiki = match[1];
  
  saveSettings(settings);
  updateGithub(settings);
  
  bot.sendMessage(chatId, `✅ Wiki set to: \`${match[1]}\``, { parse_mode: 'Markdown' });
});

// Add other command handlers (/setevents, /showconfig, etc.)

function isAdmin(msg) {
  // Implement your admin check logic
  return true;
}

console.log('🤖 Bot is running...');
