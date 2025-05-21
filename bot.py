from telegram.ext import Application, CommandHandler, ContextTypes
import asyncio
import logging

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

class WikiMonitorBot:
    def __init__(self, token: str):
        self.application = Application.builder().token(token).build()
        self.monitored_groups = {}  # group_id: {wiki: str, events: list}
        
        # Register handlers
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("subscribe", self.subscribe))
        
    async def start(self, update, context):
        await update.message.reply_text(
            "Welcome to Wikimedia Event Monitor!\n"
            "Use /subscribe <wiki> <events> to configure monitoring."
        )
    
    async def subscribe(self, update, context):
        chat_id = update.effective_chat.id
        args = context.args
        
        if len(args) < 2:
            await update.message.reply_text("Usage: /subscribe <wiki> <event1> <event2>...")
            return
            
        wiki = args[0]
        events = args[1:]
        
        self.monitored_groups[chat_id] = {
            "wiki": wiki,
            "events": events
        }
        
        await update.message.reply_text(
            f"✅ Subscribed to {wiki} for events: {', '.join(events)}"
        )
    
    async def send_event_notification(self, chat_id: int, change: dict):
        try:
            message = (
                f"📢 {change.get('type', 'event').upper()} on {change.get('wiki')}\n"
                f"📝 Page: {change.get('title')}\n"
                f"👤 User: {change.get('user')}"
            )
            
            await self.application.bot.send_message(
                chat_id=chat_id,
                text=message
            )
        except Exception as e:
            logger.error(f"Failed to send message to {chat_id}: {e}")

    def run(self):
        self.application.run_polling()
