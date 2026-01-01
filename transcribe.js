import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { v2 as speech } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import { BUCKET_NAME, GCS_TRANSCRIPTS_PREFIX, GCS_AUDIO_FILES_PREFIX, GOOGLE_KEY_PATH } from './config.js';

const { SpeechClient } = speech;
const speechClient = new SpeechClient({ keyFilename: GOOGLE_KEY_PATH, apiEndpoint: 'us-speech.googleapis.com' });
const storageClient = new Storage({ keyFilename: GOOGLE_KEY_PATH });

// --- HELPERS ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSeconds(timeString) {
  if (!timeString) return 0;
  if (timeString.includes(':')) {
    const parts = timeString.split(':').map(Number);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parseFloat(timeString.replace('s', ''));
}

function formatTime(secondsString, offsetSeconds = 0) {
  const currentSeconds = typeof secondsString === 'string' ? parseSeconds(secondsString) : secondsString;
  const totalSeconds = currentSeconds + offsetSeconds;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
}

// EXPORTED for index.js
export function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

function splitAudio(filePath, splitConfig) {
  return new Promise((resolve, reject) => {
    const { dir, name, ext } = path.parse(filePath);
    const outputPattern = path.join(dir, `${name}_part_%03d${ext}`);

    console.log(`✂️ Splitting file: ${filePath}...`);

    const command = ffmpeg(filePath).outputOptions([`-f segment`, `-c:a libmp3lame`, `-b:a 320k`, `-reset_timestamps 1`]);

    if (Array.isArray(splitConfig)) {
      const timecodeStr = splitConfig.join(',');
      console.log(`   Mode: Custom Split Points -> ${timecodeStr}`);
      command.outputOptions([`-segment_times ${timecodeStr}`]);
    } else {
      console.log(`   Mode: Auto Split Every ${splitConfig}s`);
      command.outputOptions([`-segment_time ${splitConfig}`]);
    }

    command
      .output(outputPattern)
      .on('end', () => {
        fs.readdir(dir, (err, files) => {
          if (err) return reject(err);
          const parts = files
            .filter((f) => f.startsWith(`${name}_part_`) && f.endsWith(ext))
            .map((f) => path.join(dir, f))
            .sort();
          resolve(parts);
        });
      })
      .on('error', (err) => reject(err))
      .run();
  });
}

// --- TRANSCRIPTION LOGIC ---

async function transcribePart(filename, lang, timeOffset = 0) {
  const projectId = await speechClient.getProjectId();
  const { name, base } = path.parse(filename);
  const gcsAudioUri = `gs://${BUCKET_NAME}/${GCS_AUDIO_FILES_PREFIX}${base}`;
  const gcsOutputUri = `gs://${BUCKET_NAME}/${GCS_TRANSCRIPTS_PREFIX}${name}_${Date.now()}.json`;

  try {
    await storageClient.bucket(BUCKET_NAME).upload(filename, { destination: `${GCS_AUDIO_FILES_PREFIX}${base}` });

    const request = {
      recognizer: `projects/${projectId}/locations/us/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        model: 'chirp_3',
        languageCodes: [langMap[lang]],
        features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true },
      },
      files: [{ uri: gcsAudioUri }],
      recognitionOutputConfig: { gcsOutputConfig: { uri: gcsOutputUri } },
    };

    let operation;
    let retries = 0;
    while (true) {
      try {
        const [op] = await speechClient.batchRecognize(request);
        operation = op;
        break;
      } catch (err) {
        if (err.code === 8 && retries < 5) {
          await sleep(60000);
          retries++;
        } else throw err;
      }
    }

    const [response] = await operation.promise();
    const fileResult = response.results[gcsAudioUri];
    if (!fileResult) throw new Error('Google returned no result for part.');
    if (fileResult.error) throw new Error(`Google Error: ${fileResult.error.message}`);

    const resultUri = fileResult.cloudStorageResult?.jsonResult?.uri || fileResult.cloudStorageResult?.uri;
    if (!resultUri) throw new Error('Output URI missing in response.');

    const outputFileName = resultUri.replace(`gs://${BUCKET_NAME}/`, '');
    const [tempFile] = await storageClient.bucket(BUCKET_NAME).file(outputFileName).download();
    const jsonResponse = JSON.parse(tempFile.toString());

    await Promise.allSettled([
      storageClient.bucket(BUCKET_NAME).file(`${GCS_AUDIO_FILES_PREFIX}${base}`).delete(),
      storageClient.bucket(BUCKET_NAME).file(outputFileName).delete(),
    ]);

    // --- SMART PARSING LOGIC (UPDATED) ---
    const allWords = jsonResponse.results.flatMap((r) => r.alternatives[0].words || []);

    // 1. Check if Google provided ANY punctuation
    const hasPunctuation = allWords.some((w) => /[.!?]/.test(w.word));

    let formattedTranscript = '';
    let currentLine = '';
    let currentLineStartTime = null;
    let lastWordEndTime = 0;

    allWords.forEach((wordObj, index) => {
      const { word } = wordObj;
      const start = wordObj.startOffset || '0s';
      const end = wordObj.endOffset || '0s';
      const startSeconds = parseSeconds(start);
      const endSeconds = parseSeconds(end);
      const gap = startSeconds - lastWordEndTime;

      if (currentLine === '') currentLineStartTime = startSeconds;

      // 2. Decide whether to force a split based on silence
      let shouldSplitBySilence = false;

      if (index > 0) {
        if (hasPunctuation) {
          // If punctuation exists, only split on HUGE gaps (e.g., 5 seconds silence = new paragraph)
          if (gap > 5.0) shouldSplitBySilence = true;
        } else {
          if (gap > 1.0) shouldSplitBySilence = true;
        }
      }

      if (shouldSplitBySilence && currentLine.length > 0) {
        formattedTranscript += `${formatTime(currentLineStartTime, timeOffset)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = startSeconds;
      }
      currentLine += `${word} `;
      lastWordEndTime = endSeconds;

      const isSentenceEnd = /[.!?]$/.test(word);
      const isComma = /[,]$/.test(word);

      // Safety break for very long lines without punctuation
      const isTooLong = currentLine.length > 150;

      if (isSentenceEnd || (isComma && currentLine.length > 100) || isTooLong || index === allWords.length - 1) {
        formattedTranscript += `${formatTime(currentLineStartTime, timeOffset)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = null;
      }
    });

    console.log(`✅ Part finished: ${base}`);
    return formattedTranscript;
  } catch (err) {
    console.error(`❌ Error on part ${base}:`, err.message);
    return `[Error part: ${formatTime(0, timeOffset)}]`;
  }
}

const langMap = { uk: 'uk-UA', en: 'en-US', pl: 'pl-PL', ru: 'ru-RU' };

// --- MAIN PROCESS FUNCTION ---
export async function processFile(filename, lang = 'uk', customSplitPoints = null) {
  console.log(`🚀 Starting job: ${filename} [${lang}]`);

  let filesToProcess = [];
  let chunkOffsets = [];
  let isSplit = false;

  if (customSplitPoints) {
    filesToProcess = await splitAudio(filename, customSplitPoints);
    isSplit = true;
    chunkOffsets.push(0);
    customSplitPoints.forEach((tc) => chunkOffsets.push(parseSeconds(tc)));
  } else {
    const duration = await getDuration(filename);
    const SPLIT_THRESHOLD = 1140;

    if (duration > SPLIT_THRESHOLD) {
      filesToProcess = await splitAudio(filename, SPLIT_THRESHOLD);
      isSplit = true;
      for (let i = 0; i < filesToProcess.length; i++) {
        chunkOffsets.push(i * SPLIT_THRESHOLD);
      }
    } else {
      filesToProcess = [filename];
      chunkOffsets = [0];
    }
  }

  const BATCH_SIZE = 4;
  let fullTranscript = '';

  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (file, index) => {
      await sleep(index * 2000);
      const globalIndex = i + index;
      const timeOffset = chunkOffsets[globalIndex];
      return transcribePart(file, lang, timeOffset);
    });

    const batchResults = await Promise.all(batchPromises);
    fullTranscript += batchResults.join('\n');
  }

  if (isSplit) {
    filesToProcess.forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch (e) {}
    });
    console.log('🧹 Cleaned up split parts.');
  }

  console.log(`✅ Completed: ${filename}`);
  return { formattedTranscript: fullTranscript };
}
