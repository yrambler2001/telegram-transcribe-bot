import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import ffmpeg from 'fluent-ffmpeg'; // Ensure this is installed
import { processFile } from './transcribe.js';
import { TELEGRAM_BOT_TOKEN, VOICE_MESSAGES_DIR, ALLOWED_TELEGRAM_USERS } from './config.js';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Ensure download directory exists
if (!fs.existsSync(VOICE_MESSAGES_DIR)) {
  fs.mkdirSync(VOICE_MESSAGES_DIR, { recursive: true });
}

const userPreferences = {};

// --- SECURITY CHECK ---
function isUserAllowed(msg) {
  const userId = msg.from.id;
  if (ALLOWED_TELEGRAM_USERS.includes(userId)) {
    return true;
  }
  console.log(`Unauthorized access attempt from User ID: ${userId} (${msg.from.username})`);
  return false;
}

// --- HELPER: DOWNLOAD FILE ---
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
          cleanupFiles(filePath); // Cleanup on error
          reject(err);
        });
      })
      .on('error', (err) => {
        cleanupFiles(filePath); // Cleanup on error
        reject(err);
      });
  });
}

// --- HELPER: EXTRACT AUDIO WITH FFMPEG ---
function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// --- HELPER: SAFE CLEANUP ---
// Accepts multiple file paths and deletes them if they exist
function cleanupFiles(...paths) {
  paths.forEach((filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete file: ${filePath}`, err);
      }
    }
  });
}

// --- GENERIC MEDIA HANDLER ---
// Handles Voice, Video, and Video Notes (Circles)
async function handleMediaMessage(msg, type) {
  if (!isUserAllowed(msg)) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const language = userPreferences[chatId] || 'uk'; // Default to Ukrainian

  let originalFilePath = null;
  let convertedAudioPath = null;
  let processingMsg = null;

  try {
    processingMsg = await bot.sendMessage(chatId, `⬇️ Processing ${type} (${language})...`, {
      reply_to_message_id: messageId,
    });

    // 1. Get File ID based on message type
    let fileId;
    if (type === 'voice') fileId = msg.voice.file_id;
    else if (type === 'video_note')
      fileId = msg.video_note.file_id; // Telegram "Circle"
    else if (type === 'video') fileId = msg.video.file_id;

    if (!fileId) throw new Error('Could not find file ID in message.');

    // 2. Get Download Link & Determine Extension
    const fileLink = await bot.getFileLink(fileId);
    // Telegram usually gives file paths like '.../file_0.mp4' or '.../voice.oga'
    // We try to grab the extension from the link, default to .tmp if missing
    const ext = path.extname(fileLink) || '.tmp';

    originalFilePath = path.join(VOICE_MESSAGES_DIR, `${type}_${chatId}_${Date.now()}_raw${ext}`);
    convertedAudioPath = path.join(VOICE_MESSAGES_DIR, `${type}_${chatId}_${Date.now()}_audio.mp3`);

    // 3. Download
    await downloadFile(fileLink, originalFilePath);

    // 4. Convert to MP3 (Extract Audio)
    // We convert everything to MP3 to standardize input for the transcriber
    await extractAudio(originalFilePath, convertedAudioPath);

    // 5. Transcribe
    const { formattedTranscript } = await processFile(convertedAudioPath, language);

    // 6. Send Result
    await bot.sendMessage(chatId, formattedTranscript || '⚠️ Transcription returned empty.', {
      parse_mode: 'Markdown',
      reply_to_message_id: messageId,
    });

    // Remove "Processing..." status
    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
  } catch (error) {
    console.error(`Error processing ${type}:`, error);
    bot.sendMessage(chatId, '❌ Failed to process media.', { reply_to_message_id: messageId });
  } finally {
    // 7. CLEANUP: IMPORTANT
    // This runs regardless of success or failure
    cleanupFiles(originalFilePath, convertedAudioPath);
  }
}

// --- BOT COMMANDS ---

bot.onText(/\/start/, (msg) => {
  if (!isUserAllowed(msg)) return;
  userPreferences[msg.chat.id] = 'uk';
  bot.sendMessage(msg.chat.id, 'Welcome! I transcribe voice messages, videos, and circles.\n\nDefault: Ukrainian 🇺🇦\nUse /language to switch.');
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
        [
          { text: 'Русский 🇷🇺', callback_data: 'lang_ru' },
          { text: 'Polski 🇵🇱', callback_data: 'lang_pl' },
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

  const langMap = {
    lang_en: { code: 'en', text: 'English 🇺🇸' },
    lang_uk: { code: 'uk', text: 'Українська 🇺🇦' },
    lang_ru: { code: 'ru', text: 'Русский 🇷🇺' },
    lang_pl: { code: 'pl', text: 'Polski 🇵🇱' },
  };

  if (langMap[data]) {
    userPreferences[chatId] = langMap[data].code;
    bot.sendMessage(chatId, `Language set to **${langMap[data].text}**`, { parse_mode: 'Markdown' });
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// --- MESSAGE LISTENERS ---

// 1. Voice Messages
bot.on('voice', (msg) => handleMediaMessage(msg, 'voice'));

// 2. Video Notes (Circles)
bot.on('video_note', (msg) => handleMediaMessage(msg, 'video_note'));

// 3. Regular Videos (e.g., MP4 uploads)
bot.on('video', (msg) => handleMediaMessage(msg, 'video'));

console.log('Bot is running with Voice, Video, and Video Circle support...');
