import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { processFile } from './transcribe.js';
import { TELEGRAM_BOT_TOKEN, VOICE_MESSAGES_DIR, ALLOWED_TELEGRAM_USERS } from './config.js';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const downloadDir = VOICE_MESSAGES_DIR;
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir);
}

const userPreferences = {};

function isUserAllowed(msg) {
  const userId = msg.from.id;
  if (ALLOWED_TELEGRAM_USERS.includes(userId)) {
    return true;
  }

  console.log(`Unauthorized access attempt from User ID: ${userId} (${msg.from.username})`);
  return false;
}

function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);

    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve(filePath);
        });

        file.on('error', (err) => {
          fs.unlink(filePath, () => {}); // Delete partial file
          reject(err);
        });
      })
      .on('error', (err) => {
        fs.unlink(filePath, () => {}); // Delete partial file
        reject(err);
      });
  });
}

// --- BOT COMMANDS ---

bot.onText(/\/start/, (msg) => {
  if (!isUserAllowed(msg)) return;
  userPreferences[msg.chat.id] = 'uk';
  bot.sendMessage(msg.chat.id, 'Welcome! I transcribe voice messages.\n\nCurrent language: Ukrainian 🇺🇸\nUse /language to switch.');
});

bot.onText(/\/language/, (msg) => {
  if (!isUserAllowed(msg)) return;
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'English 🇺🇸', callback_data: 'lang_en' },
          { text: 'Українська 🇺🇦', callback_data: 'lang_uk' },
        ],
      ],
    },
  };
  bot.sendMessage(msg.chat.id, 'Choose transcription language:', opts);
});

bot.on('callback_query', (callbackQuery) => {
  if (!ALLOWED_TELEGRAM_USERS.includes(callbackQuery.from.id)) return;
  const chatId = callbackQuery.message.chat.id;
  const { data } = callbackQuery;

  if (data === 'lang_en') {
    userPreferences[chatId] = 'en';
    bot.sendMessage(chatId, 'Language set to **English** 🇺🇸', { parse_mode: 'Markdown' });
  } else if (data === 'lang_uk') {
    userPreferences[chatId] = 'uk';
    bot.sendMessage(chatId, 'Мову змінено на **Українську** 🇺🇦', { parse_mode: 'Markdown' });
  }
  bot.answerCallbackQuery(callbackQuery.id);
});

// --- VOICE HANDLER ---

bot.on('voice', async (msg) => {
  if (!isUserAllowed(msg)) return;
  const chatId = msg.chat.id;
  const messageId = msg.message_id; // Capture the message ID to reply to it later
  const language = userPreferences[chatId] || 'uk';

  try {
    // 1. Notify user (replying to the voice message)
    const processingMsg = await bot.sendMessage(chatId, `⬇️ Processing (${language})...`, {
      reply_to_message_id: messageId,
    });

    // 2. Prepare paths
    const fileId = msg.voice.file_id;
    const fileName = `voice_${chatId}_${Date.now()}.ogg`;
    const filePath = path.join(downloadDir, fileName);

    // 3. Get Link & Download (using our new Promise function)
    const fileLink = await bot.getFileLink(fileId);
    await downloadFile(fileLink, filePath);

    // 4. Transcribe
    // const transcribedText = await transcribeAudio(filePath, language);
    const transcribedText = await processFile(filePath, language).then(({ formattedTranscript }) => formattedTranscript);

    // 5. Send Result (replying to the voice message)
    await bot.sendMessage(chatId, `${transcribedText}`, {
      parse_mode: 'Markdown',
      reply_to_message_id: messageId,
    });

    // Cleanup: Delete the "Processing..." status message
    bot.deleteMessage(chatId, processingMsg.message_id);

    // Optional: Delete local file
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, '❌ Failed to process audio.', { reply_to_message_id: messageId });
  }
});

console.log('Bot is running...');
