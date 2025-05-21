import logging
from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext, MessageHandler, Filters
from config import BOT_TOKEN
from utils import load_settings, save_settings_locally, update_github
from threading import Thread
from wiki_listener import stream_changes

# Enable logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

logger = logging.getLogger(__name__)
settings = load_settings()


def is_admin(update: Update, context: CallbackContext) -> bool:
    try:
        user_id = update.effective_user.id
        chat_id = update.effective_chat.id
        member = context.bot.get_chat_member(chat_id, user_id)
        return member.status in ["administrator", "creator"]
    except Exception as e:
        logger.warning("Admin check failed: %s", e)
        return False


def start(update: Update, context: CallbackContext):
    update.message.reply_text("👋 Welcome! Use /setwiki and /setevents to configure monitoring.")


def help_cmd(update: Update, context: CallbackContext):
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
    chat_id = str(update.message.chat_id)
    conf = settings.get(chat_id)
    if not conf:
        return update.message.reply_text("⚠️ No settings configured yet.")
    wiki = conf.get("wiki", "Not set")
    events = ', '.join(conf.get("events", [])) or "None"
    update.message.reply_text(f"🔧 *Current Config:*\nWiki: `{wiki}`\nEvents: `{events}`", parse_mode='Markdown')


def send_change(group_id, change):
    try:
        text = f"🔔 *{change['type']}* on {change['wiki']}:\n" \
               f"[{change['title']}](https://{change['wiki'].replace('wiki','')}.wikipedia.org/wiki/{change['title'].replace(' ', '_')})"
        updater.bot.send_message(chat_id=int(group_id), text=text, parse_mode='Markdown')
    except Exception as e:
        logger.error("Failed to send update: %s", e)


def start_listener():
    stream_changes(send_change, settings)


def unknown(update: Update, context: CallbackContext):
    update.message.reply_text("❓ Unknown command. Try /help.")


# Main
updater = Updater(BOT_TOKEN, use_context=True)
dp = updater.dispatcher

# Command handlers
dp.add_handler(CommandHandler("start", start))
dp.add_handler(CommandHandler("help", help_cmd))
dp.add_handler(CommandHandler("setwiki", set_wiki))
dp.add_handler(CommandHandler("setevents", set_events))
dp.add_handler(CommandHandler("showconfig", show_config))
dp.add_handler(MessageHandler(Filters.command, unknown))  # catch unknown commands

if __name__ == "__main__":
    print("🤖 Bot is starting...")
    Thread(target=start_listener).start()
    updater.start_polling()
    updater.idle()
