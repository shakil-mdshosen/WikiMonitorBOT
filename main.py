import logging
from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext, MessageHandler, Filters
from config import BOT_TOKEN
from utils import load_settings, save_settings_locally, update_github
from threading import Thread
import requests
import json
import time
from sseclient import SSEClient
from urllib3.response import HTTPResponse

# Enable logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

logger = logging.getLogger(__name__)
settings = load_settings()

# Constants
EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"
RECONNECT_DELAY = 5  # seconds

def is_admin(update: Update, context: CallbackContext) -> bool:
    """Check if the user is an admin in the chat."""
    try:
        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        member = context.bot.get_chat_member(chat_id, user_id)
        return member.status in ["administrator", "creator"]
    except Exception as e:
        logger.warning("Admin check failed: %s", e)
        return False

def start(update: Update, context: CallbackContext):
    """Send a welcome message when the command /start is issued."""
    update.message.reply_text("👋 Welcome! Use /setwiki and /setevents to configure monitoring.")

def help_cmd(update: Update, context: CallbackContext):
    """Send a help message when the command /help is issued."""
    update.message.reply_text(
        "📖 *Available Commands:*\n"
        "/start - Welcome message\n"
        "/setwiki <dbname> - Set the wiki (e.g., bnwiki)\n"
        "/setevents <edit> <new> <delete> <block> - Set event types\n"
        "/showconfig - Show current configuration\n"
        "/help - Show this help message",
        parse_mode='Markdown'
    )

def set_wiki(update: Update, context: CallbackContext):
    """Set the wiki to monitor."""
    if not is_admin(update, context):
        return update.message.reply_text("🚫 Admins only.")
    if not context.args:
        return update.message.reply_text("⚠️ Usage: /setwiki bnwiki")

    chat_id = str(update.message.chat_id)
    settings.setdefault(chat_id, {})["wiki"] = context.args[0]
    save_settings_locally(settings)
    update_github(settings)
    update.message.reply_text(f"✅ Wiki set to: `{context.args[0]}`", parse_mode='Markdown')

def set_events(update: Update, context: CallbackContext):
    """Set which events to monitor."""
    if not is_admin(update, context):
        return update.message.reply_text("🚫 Admins only.")
    if not context.args:
        return update.message.reply_text("⚠️ Usage: /setevents edit new delete block")

    chat_id = str(update.message.chat_id)
    settings.setdefault(chat_id, {})["events"] = context.args
    save_settings_locally(settings)
    update_github(settings)
    update.message.reply_text(f"✅ Events set to: `{', '.join(context.args)}`", parse_mode='Markdown')

def show_config(update: Update, context: CallbackContext):
    """Show the current configuration."""
    chat_id = str(update.message.chat_id)
    conf = settings.get(chat_id)
    if not conf:
        return update.message.reply_text("⚠️ No settings configured yet.")
    wiki = conf.get("wiki", "Not set")
    events = ', '.join(conf.get("events", [])) or "None"
    update.message.reply_text(f"🔧 *Current Config:*\nWiki: `{wiki}`\nEvents: `{events}`", parse_mode='Markdown')

def send_change(group_id, change):
    """Send change notification to Telegram group."""
    try:
        text = (
            f"🔔 *{change.get('type', 'event').upper()}* on {change.get('wiki')}\n"
            f"📝 Page: [{change.get('title')}]"
            f"(https://{change.get('wiki', '').replace('wiki','')}.wikipedia.org/wiki/"
            f"{change.get('title', '').replace(' ', '_')})\n"
            f"👤 User: {change.get('user', 'Anonymous')}"
        )
        updater.bot.send_message(
            chat_id=int(group_id),
            text=text,
            parse_mode='Markdown',
            disable_web_page_preview=True
        )
    except Exception as e:
        logger.error("Failed to send update to group %s: %s", group_id, e)

def stream_changes(callback, monitored_groups):
    """Listen to Wikimedia EventStream and forward relevant events."""
    logger.info("🔄 Starting EventStream listener...")
    
    while True:
        try:
            # Create a new session for each connection attempt
            session = requests.Session()
            
            # Make the initial request
            response = session.get(
                EVENTSTREAM_URL,
                stream=True,
                headers={'Accept': 'text/event-stream'},
                timeout=30
            )
            
            # Verify the response
            if response.status_code != 200:
                logger.error("Server returned status %d", response.status_code)
                response.close()
                time.sleep(RECONNECT_DELAY)
                continue
                
            # Properly initialize the SSE client
            client = SSEClient(response)
            logger.info("✅ Successfully connected to EventStream")
            
            for event in client.events():
                try:
                    if event.event != "message":
                        continue
                        
                    change = json.loads(event.data)
                    wiki = change.get("wiki")
                    change_type = change.get("type", "unknown")
                    
                    # Handle log events
                    if change_type == "log":
                        change_type = change.get("log_type", change_type)
                    
                    logger.debug("📡 Event: %s | %s", wiki, change_type)
                    
                    # Check all monitored groups
                    for group_id, config in monitored_groups.items():
                        if (config.get("wiki") == wiki and 
                            change_type in config.get("events", [])):
                            logger.info("➡️ Forwarding to group %s", group_id)
                            callback(group_id, change)
                    
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON in event")
                except Exception as e:
                    logger.error("Event processing error: %s", e)

        except requests.exceptions.RequestException as e:
            logger.error("Connection error: %s. Reconnecting in %d seconds...", e, RECONNECT_DELAY)
            time.sleep(RECONNECT_DELAY)
            
        except KeyboardInterrupt:
            logger.info("🛑 Received interrupt signal, shutting down...")
            raise
            
        except Exception as e:
            logger.error("Unexpected error: %s. Restarting in %d seconds...", e, RECONNECT_DELAY)
            time.sleep(RECONNECT_DELAY)

def start_listener():
    """Start the event listener in a separate thread."""
    stream_changes(send_change, settings)

def unknown(update: Update, context: CallbackContext):
    """Handle unknown commands."""
    update.message.reply_text("❓ Unknown command. Try /help.")

def main():
    """Start the bot."""
    global updater
    
    logger.info("🤖 Bot is starting...")
    
    # Initialize updater
    updater = Updater(BOT_TOKEN, use_context=True)
    dp = updater.dispatcher

    # Command handlers
    dp.add_handler(CommandHandler("start", start))
    dp.add_handler(CommandHandler("help", help_cmd))
    dp.add_handler(CommandHandler("setwiki", set_wiki))
    dp.add_handler(CommandHandler("setevents", set_events))
    dp.add_handler(CommandHandler("showconfig", show_config))
    dp.add_handler(MessageHandler(Filters.command, unknown))

    # Start the event listener in a separate thread
    listener_thread = Thread(target=start_listener)
    listener_thread.daemon = True
    listener_thread.start()

    # Start the bot
    updater.start_polling()
    updater.idle()

if __name__ == "__main__":
    main()
