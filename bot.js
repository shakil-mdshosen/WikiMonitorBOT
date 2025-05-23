require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const EventSource = require('eventsource');
const { loadSettings, saveSettings } = require('./utils/settings');
const { updateGithub } = require('./utils/github');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const settings = loadSettings();

// Initialize Wikimedia EventStream
const eventStreamUrl = 'https://stream.wikimedia.org/v2/stream/recentchange';
let eventSource;

function connectToEventStream() {
  eventSource = new EventSource(eventStreamUrl);

  eventSource.onopen = () => {
    console.log('✅ Connected to Wikimedia EventStream');
  };

  eventSource.onerror = (err) => {
    console.error('❌ EventStream error:', err);
    // Reconnect after delay
    setTimeout(connectToEventStream, 5000);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const wiki = data.wiki || data.meta?.domain;
      const type = data.type === 'log' ? data.log_type : data.type;

      Object.entries(settings).forEach(([chatId, config]) => {
        if (config.wiki === wiki && config.events.includes(type)) {
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

  bot.sendMessage(chatId, 
    `🔔 *${data.type.toUpperCase()}* on ${data.wiki}\n` +
    `📝 Page: [${title}](${pageUrl})\n` +
    `👤 User: ${user}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  ).catch(err => console.error(`Error sending to ${chatId}:`, err.message));
}

// Command handlers (keep your existing ones)
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

// Start the connection
connectToEventStream();

console.log('🤖 Bot is running...');

// Cleanup on exit
process.on('SIGINT', () => {
  if (eventSource) eventSource.close();
  process.exit();
});
