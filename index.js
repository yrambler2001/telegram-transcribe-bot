import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { processFile } from './transcribe.js';
import { TELEGRAM_BOT_TOKEN, VOICE_MESSAGES_DIR, ALLOWED_TELEGRAM_USERS } from './config.js';

// --- CONFIGURATION FOR LOCAL SERVER ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  // Point to your local VPS server
  baseApiUrl: 'http://localhost:8081',
});

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

// --- HELPER: EXTRACT AUDIO WITH FFMPEG ---
function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioBitrate('320k')
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

// --- HELPER: SEND LONG MESSAGES ---
// Telegram limit is 4096 chars. We split at ~4000 to be safe.
async function sendLongMessage(chatId, text, replyToMessageId) {
  const MAX_LENGTH = 4000;
  
  if (text.length <= MAX_LENGTH) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_to_message_id: replyToMessageId,
    });
  }

  const chunks = [];
  let currentText = text;

  while (currentText.length > 0) {
    if (currentText.length <= MAX_LENGTH) {
      chunks.push(currentText);
      break;
    }

    // Find the nearest newline or space before MAX_LENGTH to avoid cutting words
    let splitIndex = currentText.lastIndexOf('\n', MAX_LENGTH);
    if (splitIndex === -1) splitIndex = currentText.lastIndexOf(' ', MAX_LENGTH);
    
    // If no convenient split point found (one huge word?), hard cut it
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(currentText.substring(0, splitIndex));
    currentText = currentText.substring(splitIndex).trim(); // Remove leading space/newline
  }

  // Send chunks sequentially
  for (let i = 0; i < chunks.length; i++) {
    await bot.sendMessage(chatId, chunks[i], {
      parse_mode: 'Markdown', 
      // Only reply to the user's message with the FIRST chunk.
      // Subsequent chunks are just sent normally to avoid spamming "replies".
      reply_to_message_id: i === 0 ? replyToMessageId : undefined, 
    });
  }
}

// --- GENERIC MEDIA HANDLER ---
// Handles Voice, Video, and Video Notes (Circles)
async function handleMediaMessage(msg, type) {
  if (!isUserAllowed(msg)) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const language = userPreferences[chatId] || 'uk'; // Default to Ukrainian

  let convertedAudioPath = null;
  let localFilePath = null;
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

    // 2. Get File Info (returns the absolute path on the VPS)
    // We do NOT use getFileLink() because that tries to make a URL.
    // We want the raw path from the local server.
    const fileInfo = await bot.getFile(fileId);

    // fileInfo.file_path will be something like: /var/lib/telegram-bot-api/<token>/videos/file_0.mp4
    localFilePath = fileInfo.file_path;

    if (!localFilePath) {
      throw new Error('Local server did not return a file path.');
    }

    // Debug log to confirm we are reading from disk
    console.log(`Reading directly from disk: ${localFilePath}`);

    // 3. Prepare Output Path for the temporary MP3
    // We still need to convert it to MP3 for the transcriber
    convertedAudioPath = path.join(VOICE_MESSAGES_DIR, `${type}_${chatId}_${Date.now()}_audio.mp3`);

    // 4. Convert directly (Input is the file on disk)
    await extractAudio(localFilePath, convertedAudioPath);

    // 5. Transcribe
    const { formattedTranscript } = await processFile(convertedAudioPath, language);
    const finalText = formattedTranscript || '⚠️ Transcription returned empty.';

    // 6. Send Result (Using SAFE splitter)
    await sendLongMessage(chatId, finalText, messageId);

    // Remove "Processing..." status
    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
  } catch (error) {
    console.error(`Error processing ${type}:`, error);
    bot.sendMessage(chatId, '❌ Failed to process media.', { reply_to_message_id: messageId });
  } finally {
    // 7. CLEANUP: IMPORTANT
    // This runs regardless of success or failure
    cleanupFiles(convertedAudioPath);
    // 8. Delete the original video from the Telegram Cache
    // We only need it for the few seconds that ffmpeg is reading it.
    cleanupFiles(localFilePath);
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
