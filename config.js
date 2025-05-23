require('dotenv').config();

module.exports = {
  // Telegram Configuration
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    options: {
      polling: true
    }
  },

  // Wikimedia EventStream
  eventStream: {
    url: 'https://stream.wikimedia.org/v2/stream/recentchange',
    reconnectDelay: 5000 // 5 seconds
  },

  // GitHub Integration (optional)
  github: {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    settingsFile: 'settings.json',
    commitMessage: 'Update bot settings'
  },

  // Admin configuration
  admins: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [],

  // Environment
  isProduction: process.env.NODE_ENV === 'production'
};
