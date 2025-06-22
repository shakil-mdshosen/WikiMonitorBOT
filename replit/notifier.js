import TelegramBot from 'node-telegram-bot-api';

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

const notificationQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || notificationQueue.length === 0) return;
  
  isProcessing = true;
  const message = notificationQueue.shift();
  
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message.content, message.options);
  } catch (err) {
    console.error('Notification failed:', err);
  } finally {
    isProcessing = false;
    if (notificationQueue.length > 0) {
      setImmediate(processQueue);
    }
  }
}

export function notifyAdmin(content, options = {}) {
  notificationQueue.push({
    content,
    options: {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...options
    }
  });
  setImmediate(processQueue);
}

export function notifyError(error, context = '') {
  const message = `🚨 *Error*: ${context}\n` +
    `\`\`\`${error.message}\`\`\`\n` +
    `*Stack*: \`${error.stack?.split('\n')[1]?.trim() || 'none'}\``;
  notifyAdmin(message);
}

export function notifyConfigChange({ chatId, userId, username, action, changes }) {
  const message = `⚙️ *Config Update*\n` +
    `• *Chat*: ${chatId}\n` +
    `• *User*: [${username || userId}](tg://user?id=${userId})\n` +
    `• *Action*: ${action}\n` +
    `• *Changes*: \`\`\`json\n${JSON.stringify(changes, null, 1)}\`\`\``;
  notifyAdmin(message);
}

export function notifySystemEvent(event, details = '') {
  notifyAdmin(`🔔 *${event}*\n${details}`);
}
