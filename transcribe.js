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

// Format "HH:MM:SS" to seconds
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

// Updated Splitter: Handles both fixed time AND custom timecodes
function splitAudio(filePath, splitConfig) {
  return new Promise((resolve, reject) => {
    const { dir, name, ext } = path.parse(filePath);
    const outputPattern = path.join(dir, `${name}_part_%03d${ext}`);

    console.log(`✂️ Splitting file: ${filePath}...`);

    const command = ffmpeg(filePath).outputOptions([`-f segment`, `-c:a libmp3lame`, `-b:a 320k`, `-reset_timestamps 1`]);

    // Handle Custom vs Automatic
    if (Array.isArray(splitConfig)) {
      // Custom Timecodes (e.g., "00:10:00,00:25:30")
      const timecodeStr = splitConfig.join(',');
      console.log(`   Mode: Custom Split Points -> ${timecodeStr}`);
      command.outputOptions([`-segment_times ${timecodeStr}`]);
    } else {
      // Fixed Duration (e.g., 1140 seconds)
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
  // ... (SAME AS BEFORE) ...
  // [Copy the entire transcribePart function from the previous response here]
  // The logic inside transcribePart has not changed,
  // only how we call it (the timeOffset value) changes in processFile below.

  // -- RE-INSERTING THE FUNCTION FOR COMPLETENESS --
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

    // PARSING with Heuristic
    const allWords = jsonResponse.results.flatMap((r) => r.alternatives[0].words || []);
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

      const isSignificantPause = index > 0 && gap > 1.0;
      if (currentLine === '') currentLineStartTime = startSeconds; // Use Number for start

      if (isSignificantPause && currentLine.length > 0) {
        formattedTranscript += `${formatTime(currentLineStartTime, timeOffset)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = startSeconds;
      }
      currentLine += `${word} `;
      lastWordEndTime = endSeconds;

      const isSentenceEnd = /[.!?]$/.test(word);
      const isComma = /[,]$/.test(word);
      if (isSentenceEnd || (currentLine.length > 100 && isComma) || currentLine.length > 150 || index === allWords.length - 1) {
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
// Now accepts customSplitPoints (Array of Strings) OR null
export async function processFile(filename, lang = 'uk', customSplitPoints = null) {
  console.log(`🚀 Starting job: ${filename} [${lang}]`);

  // 1. Files Prep
  let filesToProcess = [];
  let chunkOffsets = []; // Store start time (in seconds) for each chunk
  let isSplit = false;

  if (customSplitPoints) {
    // --- MANUAL SPLIT MODE ---
    filesToProcess = await splitAudio(filename, customSplitPoints);
    isSplit = true;

    // Calculate offsets for Manual Splits
    // e.g., ["00:10:00", "00:25:00"]
    // Part 0 starts at 0
    // Part 1 starts at 600s
    // Part 2 starts at 1500s
    chunkOffsets.push(0);
    customSplitPoints.forEach((tc) => chunkOffsets.push(parseSeconds(tc)));
  } else {
    // --- AUTOMATIC SPLIT MODE ---
    // Note: index.js logic implies we only reach here if duration < 19m
    // But kept for safety/backward compatibility
    const duration = await getDuration(filename);
    const SPLIT_THRESHOLD = 1140;

    if (duration > SPLIT_THRESHOLD) {
      filesToProcess = await splitAudio(filename, SPLIT_THRESHOLD);
      isSplit = true;
      // Calculate offsets for Auto Splits (0, 1140, 2280...)
      for (let i = 0; i < filesToProcess.length; i++) {
        chunkOffsets.push(i * SPLIT_THRESHOLD);
      }
    } else {
      filesToProcess = [filename];
      chunkOffsets = [0];
    }
  }

  // 2. Processing Loop
  const BATCH_SIZE = 4;
  let fullTranscript = '';

  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (file, index) => {
      await sleep(index * 2000);
      const globalIndex = i + index;

      // Use the specific calculated offset for this chunk
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
