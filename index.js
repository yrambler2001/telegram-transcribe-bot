import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { processFile } from './transcribe.js';
import { TELEGRAM_BOT_TOKEN, VOICE_MESSAGES_DIR, ALLOWED_TELEGRAM_USERS } from './config.js';

// --- CONFIGURATION ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  baseApiUrl: 'http://localhost:8081',
});

if (!fs.existsSync(VOICE_MESSAGES_DIR)) {
  fs.mkdirSync(VOICE_MESSAGES_DIR, { recursive: true });
}

// CONSTANTS
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every 1 minute

// Store pending files: Key = chatId, Value = { fileId, type, originalMessageId, promptMessageId, timestamp }
const pendingRequests = new Map();

// --- AUTOMATIC EXPIRATION CLEANUP ---
setInterval(() => {
  const now = Date.now();

  for (const [chatId, request] of pendingRequests.entries()) {
    if (now - request.timestamp > REQUEST_TIMEOUT_MS) {
      // 1. Remove from memory
      pendingRequests.delete(chatId);

      // 2. Notify user by editing the button message
      bot
        .editMessageText('❌ Request expired (15m timeout). Please resend.', {
          chat_id: chatId,
          message_id: request.promptMessageId,
        })
        .catch((err) => {
          // Ignore errors (e.g., if user deleted the chat)
        });

      console.log(`Expired pending request for Chat ID: ${chatId}`);
    }
  }
}, CLEANUP_INTERVAL_MS);

// --- SECURITY CHECK ---
function isUserAllowed(msg) {
  const userId = msg.from.id;
  if (ALLOWED_TELEGRAM_USERS.includes(userId)) return true;
  console.log(`Unauthorized: ${userId}`);
  return false;
}

// --- HELPER: FFMPEG EXTRACTION ---
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

// --- HELPER: CLEANUP ---
function cleanupFiles(...paths) {
  paths.forEach((filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

// --- HELPER: SEND LONG MESSAGES ---
async function sendLongMessage(chatId, text, replyToMessageId) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_to_message_id: replyToMessageId });
  }

  const chunks = [];
  let currentText = text;
  while (currentText.length > 0) {
    if (currentText.length <= MAX_LENGTH) {
      chunks.push(currentText);
      break;
    }
    let splitIndex = currentText.lastIndexOf('\n', MAX_LENGTH);
    if (splitIndex === -1) splitIndex = currentText.lastIndexOf(' ', MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(currentText.substring(0, splitIndex));
    currentText = currentText.substring(splitIndex).trim();
  }

  for (let i = 0; i < chunks.length; i++) {
    await bot.sendMessage(chatId, chunks[i], {
      parse_mode: 'Markdown',
      reply_to_message_id: replyToMessageId,
    });
  }
}

// --- STEP 1: RECEIVE FILE & ASK FOR LANGUAGE ---
async function handleMediaMessage(msg, type) {
  if (!isUserAllowed(msg)) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  let fileId;
  if (type === 'voice') fileId = msg.voice.file_id;
  else if (type === 'video_note') fileId = msg.video_note.file_id;
  else if (type === 'video') fileId = msg.video.file_id;

  if (!fileId) return bot.sendMessage(chatId, '❌ Error: No file ID found.');

  const opts = {
    reply_to_message_id: messageId,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🇺🇸 English', callback_data: 'lang_en' },
          { text: '🇺🇦 Ukrainian', callback_data: 'lang_uk' },
        ],
        [
          { text: '🇷🇺 Russian', callback_data: 'lang_ru' },
          { text: '🇵🇱 Polish', callback_data: 'lang_pl' },
        ],
        [{ text: '❌ Cancel', callback_data: 'cancel' }],
      ],
    },
  };

  // Send the prompt and capture the sent message (so we can delete/edit it later)
  const promptMsg = await bot.sendMessage(chatId, `Detected **${type}**. Choose language to transcribe:`, { parse_mode: 'Markdown', ...opts });

  // Store Request in Memory with Timestamp
  pendingRequests.set(chatId, {
    fileId,
    type,
    originalMessageId: messageId,
    promptMessageId: promptMsg.message_id, // <--- Saved for expiration editing
    timestamp: Date.now(), // <--- Saved for timeout check
  });
}

// --- STEP 2: HANDLE BUTTON CLICK & PROCESS ---
bot.on('callback_query', async (callbackQuery) => {
  if (!ALLOWED_TELEGRAM_USERS.includes(callbackQuery.from.id)) return;

  const chatId = callbackQuery.message.chat.id;
  const { data } = callbackQuery;
  const messageIdOfPrompt = callbackQuery.message.message_id;

  // 1. ANSWER IMMEDIATELY (Fixes "query is too old" error)
  // We answer right away so the button stops "loading" on the user's screen.
  // We use .catch() to ignore errors if the user clicked too late.
  bot.answerCallbackQuery(callbackQuery.id).catch((err) => {});

  // Handle Cancel
  if (data === 'cancel') {
    pendingRequests.delete(chatId);
    bot.deleteMessage(chatId, messageIdOfPrompt).catch(() => {});
    return;
  }

  // Retrieve Request
  const request = pendingRequests.get(chatId);

  if (!request) {
    return bot
      .editMessageText('⚠️ Request expired or not found. Please resend.', {
        chat_id: chatId,
        message_id: messageIdOfPrompt,
      })
      .catch(() => {});
  }

  // Determine Language
  const langCode = data.replace('lang_', '');

  // Cleanup UI
  bot.deleteMessage(chatId, messageIdOfPrompt).catch(() => {});
  pendingRequests.delete(chatId);

  // --- START PROCESSING ---
  // Now we can take as long as we want because we already answered the button.
  await processMediaRequest(chatId, request, langCode);
});

// --- CORE PROCESSING LOGIC ---
async function processMediaRequest(chatId, request, language) {
  const { fileId, type, originalMessageId } = request;
  let convertedAudioPath = null;
  let localFilePath = null;
  let processingMsg = null;

  try {
    processingMsg = await bot.sendMessage(chatId, `⬇️ Processing ${type} (${language})...`, {
      reply_to_message_id: originalMessageId,
    });

    const fileInfo = await bot.getFile(fileId);
    localFilePath = fileInfo.file_path;

    if (!localFilePath) throw new Error('Local server did not return a file path.');
    console.log(`Processing: ${localFilePath}`);

    convertedAudioPath = path.join(VOICE_MESSAGES_DIR, `${type}_${chatId}_${Date.now()}_audio.mp3`);
    await extractAudio(localFilePath, convertedAudioPath);

    const { formattedTranscript } = await processFile(convertedAudioPath, language);
    const finalText = formattedTranscript || '⚠️ Transcription returned empty.';

    await sendLongMessage(chatId, finalText, originalMessageId);

    bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
  } catch (error) {
    console.error(`Error processing ${type}:`, error);
    bot.sendMessage(chatId, '❌ Failed to process media.', { reply_to_message_id: originalMessageId });
  } finally {
    cleanupFiles(convertedAudioPath);
    cleanupFiles(localFilePath);
  }
}

// --- COMMANDS ---
bot.onText(/\/start/, (msg) => {
  if (isUserAllowed(msg)) {
    bot.sendMessage(msg.chat.id, 'Welcome! Send me a Voice, Video, or Video Note, and I will ask you for the language.');
  }
});

// --- LISTENERS ---
bot.on('voice', (msg) => handleMediaMessage(msg, 'voice'));
bot.on('video_note', (msg) => handleMediaMessage(msg, 'video_note'));
bot.on('video', (msg) => handleMediaMessage(msg, 'video'));

console.log('Bot is running with 15m timeout...');
