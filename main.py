from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext
from config import BOT_TOKEN
from utils import load_settings, save_settings_locally, update_github
from threading import Thread
from wiki_listener import stream_changes

settings = load_settings()

def is_admin(update):
    user = update.effective_user
    chat_member = update.effective_chat.get_member(user.id)
    return chat_member.status in ["administrator", "creator"]

def start(update: Update, context: CallbackContext):
    update.message.reply_text("👋 Welcome! Use /setwiki and /setevents to configure monitoring.")

def set_wiki(update: Update, context: CallbackContext):
    if not is_admin(update): return update.message.reply_text("Admins only.")
    if not context.args: return update.message.reply_text("Usage: /setwiki bnwiki")
    
    chat_id = str(update.message.chat_id)
    settings.setdefault(chat_id, {})["wiki"] = context.args[0]
    save_settings_locally(settings)
    update_github(settings)
    update.message.reply_text(f"✅ Set wiki to {context.args[0]}")

def set_events(update: Update, context: CallbackContext):
    if not is_admin(update): return update.message.reply_text("Admins only.")
    if not context.args: return update.message.reply_text("Usage: /setevents edit new delete block")

    chat_id = str(update.message.chat_id)
    settings.setdefault(chat_id, {})["events"] = context.args
    save_settings_locally(settings)
    update_github(settings)
    update.message.reply_text(f"✅ Events to monitor: {', '.join(context.args)}")

def show_config(update: Update, context: CallbackContext):
    chat_id = str(update.message.chat_id)
    conf = settings.get(chat_id)
    if not conf:
        return update.message.reply_text("⚠️ No settings configured yet.")
    update.message.reply_text(f"Wiki: {conf.get('wiki')}\nEvents: {', '.join(conf.get('events', []))}")

def send_change(group_id, change):
    try:
        text = f"🔔 *{change['type']}* on {change['wiki']}:\n[{change['title']}](https://{change['wiki'].replace('wiki','')}.wikipedia.org/wiki/{change['title'].replace(' ', '_')})"
        updater.bot.send_message(chat_id=int(group_id), text=text, parse_mode='Markdown')
    except Exception as e:
        print("Failed to send update:", e)

def start_listener():
    stream_changes(send_change, settings)

updater = Updater(BOT_TOKEN)
dp = updater.dispatcher

dp.add_handler(CommandHandler("start", start))
dp.add_handler(CommandHandler("setwiki", set_wiki))
dp.add_handler(CommandHandler("setevents", set_events))
dp.add_handler(CommandHandler("showconfig", show_config))

if __name__ == "__main__":
    Thread(target=start_listener).start()
    updater.start_polling()
    updater.idle()
