import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import EventSource from 'eventsource';
import { loadSettings, saveSettings } from './utils/settings.js';
import { updateGithub } from './utils/github.js';

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  eventStreamUrl: 'https://stream.wikimedia.org/v2/stream/recentchange'
};

const bot = new TelegramBot(config.telegramToken, { polling: true });
const settings = loadSettings();

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

      for (const [chatId, config] of Object.entries(settings)) {
        if (config.wiki === wiki && config.events.includes(type)) {
          sendNotification(chatId, data);
        }
      }
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

  bot.sendMessage(
    chatId, 
    `🔔 *${data.type.toUpperCase()}* on ${data.wiki}\n` +
    `📝 Page: [${title}](${pageUrl})\n` +
    `👤 User: ${user}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  ).catch(err => console.error(`Error sending to ${chatId}:`, err.message));
}

// Command handlers
bot.onText(/\/start/, (msg) => {
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

// Add other command handlers as needed

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
