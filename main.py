import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters
from config import BOT_TOKEN
from utils import load_settings, save_settings_locally, update_github
import asyncio
import aiohttp
import json

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Constants
EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"
RECONNECT_DELAY = 5
settings = load_settings()

class WikiMonitorBot:
    def __init__(self):
        self.application = Application.builder().token(BOT_TOKEN).build()
        self._register_handlers()
        self.session = None

    def _register_handlers(self):
        """Register all command handlers"""
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("help", self.help_cmd))
        self.application.add_handler(CommandHandler("setwiki", self.set_wiki))
        self.application.add_handler(CommandHandler("setevents", self.set_events))
        self.application.add_handler(CommandHandler("showconfig", self.show_config))
        self.application.add_handler(MessageHandler(filters.COMMAND, self.unknown))

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Send welcome message"""
        await update.message.reply_text("👋 Welcome! Use /setwiki and /setevents to configure monitoring.")

    async def help_cmd(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Send help message"""
        await update.message.reply_text(
            "📖 *Available Commands:*\n"
            "/start - Welcome message\n"
            "/setwiki <dbname> - Set the wiki (e.g., bnwiki)\n"
            "/setevents <edit> <new> <delete> <block> - Set event types\n"
            "/showconfig - Show current configuration\n"
            "/help - Show this help message",
            parse_mode='Markdown'
        )

    async def set_wiki(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Set wiki to monitor"""
        if not await self.is_admin(update, context):
            return await update.message.reply_text("🚫 Admins only.")
        if not context.args:
            return await update.message.reply_text("⚠️ Usage: /setwiki bnwiki")

        chat_id = str(update.message.chat_id)
        settings.setdefault(chat_id, {})["wiki"] = context.args[0]
        save_settings_locally(settings)
        update_github(settings)
        await update.message.reply_text(f"✅ Wiki set to: `{context.args[0]}`", parse_mode='Markdown')

    async def set_events(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Set events to monitor"""
        if not await self.is_admin(update, context):
            return await update.message.reply_text("🚫 Admins only.")
        if not context.args:
            return await update.message.reply_text("⚠️ Usage: /setevents edit new delete block")

        chat_id = str(update.message.chat_id)
        settings.setdefault(chat_id, {})["events"] = context.args
        save_settings_locally(settings)
        update_github(settings)
        await update.message.reply_text(f"✅ Events set to: `{', '.join(context.args)}`", parse_mode='Markdown')

    async def show_config(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show current configuration"""
        chat_id = str(update.message.chat_id)
        conf = settings.get(chat_id)
        if not conf:
            return await update.message.reply_text("⚠️ No settings configured yet.")
        wiki = conf.get("wiki", "Not set")
        events = ', '.join(conf.get("events", [])) or "None"
        await update.message.reply_text(f"🔧 *Current Config:*\nWiki: `{wiki}`\nEvents: `{events}`", parse_mode='Markdown')

    async def unknown(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle unknown commands"""
        await update.message.reply_text("❓ Unknown command. Try /help.")

    async def is_admin(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
        """Check if user is admin"""
        try:
            user_id = update.effective_user.id
            chat_id = update.effective_chat.id
            member = await context.bot.get_chat_member(chat_id, user_id)
            return member.status in ["administrator", "creator"]
        except Exception as e:
            logger.warning("Admin check failed: %s", e)
            return False

    async def send_change(self, group_id: int, change: dict):
        """Send change notification to Telegram group"""
        try:
            text = (
                f"🔔 *{change.get('type', 'event').upper()}* on {change.get('wiki')}\n"
                f"📝 Page: [{change.get('title')}]"
                f"(https://{change.get('wiki', '').replace('wiki','')}.wikipedia.org/wiki/"
                f"{change.get('title', '').replace(' ', '_')})\n"
                f"👤 User: {change.get('user', 'Anonymous')}"
            )
            await self.application.bot.send_message(
                chat_id=group_id,
                text=text,
                parse_mode='Markdown',
                disable_web_page_preview=True
            )
        except Exception as e:
            logger.error("Failed to send update to group %s: %s", group_id, e)

    async def listen_to_events(self):
        """Listen to Wikimedia EventStream"""
        self.session = aiohttp.ClientSession()
        logger.info("🔄 Starting EventStream listener...")
        
        while True:
            try:
                async with self.session.get(
                    EVENTSTREAM_URL,
                    headers={'Accept': 'text/event-stream'},
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as response:
                    if response.status != 200:
                        logger.error("Server returned status %d", response.status)
                        await asyncio.sleep(RECONNECT_DELAY)
                        continue
                        
                    async for line in response.content:
                        if line.startswith(b'data: '):
                            try:
                                event = json.loads(line[6:].decode('utf-8'))
                                wiki = event.get("wiki")
                                change_type = event.get("type", "unknown")
                                
                                if change_type == "log":
                                    change_type = event.get("log_type", change_type)
                                
                                logger.debug("📡 Event: %s | %s", wiki, change_type)
                                
                                for group_id, config in settings.items():
                                    if (config.get("wiki") == wiki and 
                                        change_type in config.get("events", [])):
                                        logger.info("➡️ Forwarding to group %s", group_id)
                                        await self.send_change(int(group_id), event)
                                
                            except json.JSONDecodeError:
                                logger.warning("Invalid JSON in event")
                            except Exception as e:
                                logger.error("Event processing error: %s", e)
            
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                logger.error("Connection error: %s. Reconnecting in %d seconds...", e, RECONNECT_DELAY)
                await asyncio.sleep(RECONNECT_DELAY)
            except Exception as e:
                logger.error("Unexpected error: %s. Restarting in %d seconds...", e, RECONNECT_DELAY)
                await asyncio.sleep(RECONNECT_DELAY)

    async def on_shutdown(self, app):
        """Cleanup on shutdown"""
        if self.session:
            await self.session.close()

    def run(self):
        """Run the application"""
        self.application.run_polling()

async def main():
    """Main async function"""
    bot = WikiMonitorBot()
    
    # Create tasks for both bot and event listener
    bot_task = asyncio.create_task(bot.run())
    listener_task = asyncio.create_task(bot.listen_to_events())
    
    # Run both tasks
    await asyncio.gather(bot_task, listener_task)

if __name__ == "__main__":
    asyncio.run(main())
