# Wikimedia Event Monitor Telegram Bot 🤖

A Node.js Telegram bot that monitors Wikimedia (Wikipedia) events in real-time and sends notifications to configured Telegram groups/channels.

## Features ✨

- Real-time monitoring of Wikimedia events (edits, new pages, deletions, etc.)
- Configurable per group:
  - Set target wiki (enwiki, bnwiki, etc.)
  - Select event types to monitor
  - Pause/resume notifications
- Detailed event reports with:
  - Diff links for edits
  - User contribution links
  - Page move tracking
  - Block/protection details
- Admin controls with permission system
- GitHub sync for settings persistence (optional)
- Automatic reconnection if connection drops

## Prerequisites 📋

- Node.js v18+
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- (Optional) GitHub Personal Access Token for settings sync

## Installation ⚙️

Made with ❤️ by Shakil Hosen
