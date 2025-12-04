import os
from telegram.ext import Updater, CommandHandler

def start(update, context):
    update.message.reply_text("Halo! Bot kamu sudah aktif 😄")

def main():
    token = os.getenv("8273945047:AAFI_lenVztYDyqLHSD4Z740e11lI9WfPcE")
    updater = Updater(token, use_context=True)

    dp = updater.dispatcher
    dp.add_handler(CommandHandler("start", start))

    updater.start_polling()
    updater.idle()

if __name__ == '__main__':
    main()