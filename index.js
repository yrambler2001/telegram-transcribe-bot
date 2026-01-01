import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { processFile, getDuration } from './transcribe.js'; // Added getDuration import
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
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_SEGMENT_DURATION_SEC = 19 * 60; // 19 Minutes

// STATE MANAGEMENT
const pendingRequests = new Map(); // Setup phase (choosing language)
const waitingForTimecodes = new Map(); // Manual split phase (chatId -> { filePath, lang, originalMessageId, duration })

// --- CLEANUP INTERVAL ---
setInterval(() => {
  const now = Date.now();
  // Cleanup pending setup requests
  for (const [chatId, request] of pendingRequests.entries()) {
    if (now - request.timestamp > REQUEST_TIMEOUT_MS) {
      pendingRequests.delete(chatId);
      bot.editMessageText('❌ Request expired.', { chat_id: chatId, message_id: request.promptMessageId }).catch(() => {});
    }
  }
  // Cleanup waiting timecode requests
  for (const [chatId, data] of waitingForTimecodes.entries()) {
    if (now - data.timestamp > REQUEST_TIMEOUT_MS) {
      waitingForTimecodes.delete(chatId);
      cleanupFiles(data.filePath);
      bot.sendMessage(chatId, '❌ Timecode entry timed out. File deleted.');
    }
  }
}, CLEANUP_INTERVAL_MS);

// --- HELPERS ---

function isUserAllowed(msg) {
  const userId = msg.from.id;
  if (ALLOWED_TELEGRAM_USERS.includes(userId)) return true;
  console.log(`Unauthorized: ${userId}`);
  return false;
}

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

// Parse HH:MM:SS to seconds
function parseTimecode(str) {
  const parts = str.trim().split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Convert seconds to HH:MM:SS
function formatDuration(sec) {
  return new Date(sec * 1000).toISOString().substr(11, 8);
}

// --- MESSAGE HANDLER (For Timecode Input) ---
bot.on('message', async (msg) => {
  if (!isUserAllowed(msg)) return;
  const chatId = msg.chat.id;

  // Check if we are waiting for timecodes from this user
  if (!waitingForTimecodes.has(chatId)) return;

  const state = waitingForTimecodes.get(chatId);
  const text = msg.text || '';

  // 1. Parse Input
  const timecodes = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (timecodes.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Please send at least one timecode (HH:MM:SS).');
  }

  // 2. Validate Format & Logic
  const splitPoints = [];
  let previousTime = 0;

  for (const tc of timecodes) {
    const seconds = parseTimecode(tc);
    if (seconds === null) {
      return bot.sendMessage(chatId, `❌ Invalid format: "${tc}". Please use HH:MM:SS (e.g., 00:15:30).`);
    }
    if (seconds <= previousTime) {
      return bot.sendMessage(chatId, `❌ Invalid order: "${tc}" must be later than previous split.`);
    }
    if (seconds >= state.duration) {
      return bot.sendMessage(chatId, `❌ Timecode "${tc}" is beyond file duration (${formatDuration(state.duration)}).`);
    }

    // Check segment length
    if (seconds - previousTime > MAX_SEGMENT_DURATION_SEC) {
      return bot.sendMessage(chatId, `❌ Segment too long! Gap before "${tc}" is > 19 mins. Please add an intermediate split.`);
    }

    splitPoints.push(tc); // Keep string format for ffmpeg
    previousTime = seconds;
  }

  // Check final segment (last split -> end of file)
  if (state.duration - previousTime > MAX_SEGMENT_DURATION_SEC) {
    return bot.sendMessage(chatId, `❌ Final segment too long! Gap from "${timecodes[timecodes.length - 1]}" to end is > 19 mins.`);
  }

  // 3. SUCCESS - Proceed to Processing
  waitingForTimecodes.delete(chatId);
  bot.sendMessage(chatId, '✅ Timecodes accepted. Splitting and processing...');

  await executeTranscription(chatId, state.filePath, state.lang, state.originalMessageId, state.localFilePath, splitPoints);
});

// --- STEP 1: INITIAL SETUP ---
async function handleMediaMessage(msg, type) {
  if (!isUserAllowed(msg)) return;
  const chatId = msg.chat.id;

  // Clean up any existing wait states for this chat
  waitingForTimecodes.delete(chatId);

  let fileId;
  if (type === 'voice') fileId = msg.voice.file_id;
  else if (type === 'video_note') fileId = msg.video_note.file_id;
  else if (type === 'video') fileId = msg.video.file_id;

  if (!fileId) return bot.sendMessage(chatId, '❌ Error: No file ID found.');

  const promptMsg = await bot.sendMessage(chatId, `Detected **${type}**. Choose language:`, {
    reply_to_message_id: msg.message_id,
    parse_mode: 'Markdown',
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
  });

  pendingRequests.set(chatId, {
    fileId,
    type,
    originalMessageId: msg.message_id,
    promptMessageId: promptMsg.message_id,
    timestamp: Date.now(),
  });
}

// --- STEP 2: BUTTON CLICK ---
bot.on('callback_query', async (query) => {
  if (!ALLOWED_TELEGRAM_USERS.includes(query.from.id)) return;
  const chatId = query.message.chat.id;
  const { data } = query;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'cancel') {
    pendingRequests.delete(chatId);
    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return;
  }

  const request = pendingRequests.get(chatId);
  if (!request) return bot.editMessageText('⚠️ Expired.', { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});

  bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
  pendingRequests.delete(chatId);

  const langCode = data.replace('lang_', '');
  await prepareFileForProcessing(chatId, request, langCode);
});

// --- STEP 3: PREPARE & CHECK DURATION ---
async function prepareFileForProcessing(chatId, request, lang) {
  let convertedAudioPath = null;
  let localFilePath = null;
  let processingMsg = null;

  try {
    processingMsg = await bot.sendMessage(chatId, `⬇️ Downloading & Checking duration...`, { reply_to_message_id: request.originalMessageId });

    const fileInfo = await bot.getFile(request.fileId);
    localFilePath = fileInfo.file_path;

    if (!localFilePath) throw new Error('Local server error.');

    // Convert to MP3
    convertedAudioPath = path.join(VOICE_MESSAGES_DIR, `${request.type}_${chatId}_${Date.now()}_audio.mp3`);
    await extractAudio(localFilePath, convertedAudioPath);

    // Check Duration
    const duration = await getDuration(convertedAudioPath);
    console.log(`Duration: ${duration}s`);

    // Logic Branch
    if (duration > MAX_SEGMENT_DURATION_SEC) {
      // > 19 Mins: ASK USER
      waitingForTimecodes.set(chatId, {
        filePath: convertedAudioPath,
        localFilePath, // Keep reference to clean up later
        lang,
        originalMessageId: request.originalMessageId,
        duration,
        timestamp: Date.now(),
      });

      const totalTimeStr = formatDuration(duration);
      const msgText =
        `⚠️ **File is too long (${totalTimeStr})**\n` +
        `Service allows max 19 min segments.\n\n` +
        `Please **reply to this message** with a list of timecodes (HH:MM:SS) where I should split the video.\n` +
        `Example for a 45 min video:\n` +
        `\`00:15:00\`\n` +
        `\`00:30:00\`\n\n` +
        `_Each segment must be < 19 minutes._`;

      await bot.editMessageText(msgText, {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      });
    } else {
      // < 19 Mins: PROCESS IMMEDIATELY
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
      await executeTranscription(chatId, convertedAudioPath, lang, request.originalMessageId, localFilePath, null);
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, '❌ Error preparing file.', { reply_to_message_id: request.originalMessageId });
    cleanupFiles(convertedAudioPath, localFilePath);
  }
}

// --- STEP 4: EXECUTE TRANSCRIPTION ---
async function executeTranscription(chatId, audioPath, lang, replyMsgId, originalSourcePath, splitPoints) {
  let procMsg = null;
  try {
    procMsg = await bot.sendMessage(chatId, `🎙️ Transcribing (${lang})...`, { reply_to_message_id: replyMsgId });

    // Pass splitPoints (if any) to transcribe.js
    const { formattedTranscript } = await processFile(audioPath, lang, splitPoints);
    const finalText = formattedTranscript || '⚠️ Empty result.';

    await sendLongMessage(chatId, finalText, replyMsgId);
    bot.deleteMessage(chatId, procMsg.message_id).catch(() => {});
  } catch (err) {
    console.error('Transcription failed:', err);
    bot.sendMessage(chatId, '❌ Transcription failed.');
  } finally {
    cleanupFiles(audioPath, originalSourcePath);
  }
}

// --- LISTENERS ---
bot.on('voice', (msg) => handleMediaMessage(msg, 'voice'));
bot.on('video_note', (msg) => handleMediaMessage(msg, 'video_note'));
bot.on('video', (msg) => handleMediaMessage(msg, 'video'));

console.log('Bot is running (Manual Split Mode)...');
