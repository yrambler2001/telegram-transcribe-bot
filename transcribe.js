import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { v2 as speech } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import { BUCKET_NAME, GCS_TRANSCRIPTS_PREFIX, GCS_AUDIO_FILES_PREFIX, GOOGLE_KEY_PATH } from './config.js';

const { SpeechClient } = speech;

const speechClient = new SpeechClient({
  keyFilename: GOOGLE_KEY_PATH,
  apiEndpoint: 'us-speech.googleapis.com',
});

const storageClient = new Storage({ keyFilename: GOOGLE_KEY_PATH });

// --- HELPERS ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatTime(secondsString, offsetSeconds = 0) {
  if (!secondsString) return formatTime('0s', offsetSeconds);

  const currentSeconds = parseFloat(secondsString.replace('s', ''));
  const totalSeconds = currentSeconds + offsetSeconds;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
}

// Convert "1.200s" string to float 1.2
function parseSeconds(timeString) {
  return timeString ? parseFloat(timeString.replace('s', '')) : 0;
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

function splitAudio(filePath, segmentTime = 1140) {
  return new Promise((resolve, reject) => {
    const { dir, name, ext } = path.parse(filePath);
    const outputPattern = path.join(dir, `${name}_part_%03d${ext}`);

    console.log(`✂️ Splitting large file (Re-encoding): ${filePath}...`);

    ffmpeg(filePath)
      .outputOptions([`-f segment`, `-segment_time ${segmentTime}`, `-c:a libmp3lame`, `-b:a 320k`, `-reset_timestamps 1`])
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

// --- CORE GCS TRANSCRIPTION LOGIC ---
async function transcribePart(filename, lang, timeOffset = 0) {
  const projectId = await speechClient.getProjectId();
  const { name, base } = path.parse(filename);

  const gcsAudioUri = `gs://${BUCKET_NAME}/${GCS_AUDIO_FILES_PREFIX}${base}`;
  const gcsOutputUri = `gs://${BUCKET_NAME}/${GCS_TRANSCRIPTS_PREFIX}${name}_${Date.now()}.json`;

  try {
    console.log(`⬆️ Uploading part: ${base}...`);
    await storageClient.bucket(BUCKET_NAME).upload(filename, {
      destination: `${GCS_AUDIO_FILES_PREFIX}${base}`,
    });

    const request = {
      recognizer: `projects/${projectId}/locations/us/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        model: 'chirp_3',
        languageCodes: [langMap[lang]],
        features: {
          enableWordTimeOffsets: true,
          enableAutomaticPunctuation: true,
        },
      },
      files: [{ uri: gcsAudioUri }],
      recognitionOutputConfig: {
        gcsOutputConfig: { uri: gcsOutputUri },
      },
    };

    let operation;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (true) {
      try {
        const [op] = await speechClient.batchRecognize(request);
        operation = op;
        break;
      } catch (err) {
        if (err.code === 8 && retries < MAX_RETRIES) {
          const waitTime = 60000 + Math.random() * 5000;
          console.warn(`⏳ Quota exceeded on ${base}. Pausing ${Math.round(waitTime / 1000)}s...`);
          await sleep(waitTime);
          retries++;
        } else {
          throw err;
        }
      }
    }

    console.log(`🤖 Processing part: ${base}`);
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

    // --- SMART PARSING WITH SILENCE HEURISTIC ---
    const allWords = jsonResponse.results.flatMap((r) => r.alternatives[0].words || []);
    let formattedTranscript = '';
    let currentLine = '';
    let currentLineStartTime = null;
    let lastWordEndTime = 0; // Track when the previous word ended

    allWords.forEach((wordObj, index) => {
      const { word } = wordObj;
      const start = wordObj.startOffset || '0s';
      const end = wordObj.endOffset || '0s';

      const startSeconds = parseSeconds(start);
      const endSeconds = parseSeconds(end);

      // Check gap from previous word
      const gap = startSeconds - lastWordEndTime;

      // Heuristic: If gap is big, assume a pause/sentence break
      // 1.0s = New Line
      // 0.6s = Comma (visual only, we won't insert ',' but we might break line if line is long)
      const isSignificantPause = index > 0 && gap > 1.0;

      if (currentLine === '') currentLineStartTime = start;

      // If significant pause detected and we have content, flush the line
      if (isSignificantPause && currentLine.length > 0) {
        formattedTranscript += `${formatTime(currentLineStartTime, timeOffset)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = start;
      }

      currentLine += `${word} `;
      lastWordEndTime = endSeconds;

      // Standard Punctuation Checks (Google Provided)
      const isSentenceEnd = /[.!?]$/.test(word);
      const isComma = /[,]$/.test(word);
      const isLong = currentLine.length > 100;

      // Flush if:
      // 1. Google gave us a period/question mark
      // 2. Line is long AND Google gave us a comma
      // 3. Line is very long (>150 chars) to prevent walls of text
      // 4. It's the last word
      if (isSentenceEnd || (isLong && isComma) || currentLine.length > 150 || index === allWords.length - 1) {
        formattedTranscript += `${formatTime(currentLineStartTime, timeOffset)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = null;
      }
    });

    console.log(`✅ Part finished: ${base} (Length: ${formattedTranscript.length} chars)`);

    return formattedTranscript;
  } catch (err) {
    console.error(`❌ Error on part ${base}:`, err.message);
    return `[Error processing part starting at ${formatTime('0s', timeOffset)}]`;
  }
}

const langMap = {
  uk: 'uk-UA',
  en: 'en-US',
  pl: 'pl-PL',
  ru: 'ru-RU',
};

// --- MAIN EXPORTED FUNCTION ---
export async function processFile(filename, lang = 'uk') {
  console.log(`🚀 Starting job for: ${filename} [${lang}]`);

  const duration = await getDuration(filename);
  console.log(`⏱️ Duration: ${Math.round(duration)}s`);

  if (duration > 10800) {
    throw new Error(`File is too long (${Math.round(duration / 60)}m). Limit is 3 hours.`);
  }

  const SPLIT_THRESHOLD = 1140;
  let filesToProcess = [];
  let isSplit = false;

  if (duration > SPLIT_THRESHOLD) {
    filesToProcess = await splitAudio(filename, SPLIT_THRESHOLD);
    isSplit = true;
  } else {
    filesToProcess = [filename];
  }

  const BATCH_SIZE = 4;
  let fullTranscript = '';

  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    console.log(`📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filesToProcess.length / BATCH_SIZE)} (${batch.length} files)...`);

    const batchPromises = batch.map(async (file, index) => {
      await sleep(index * 2000);
      const globalIndex = i + index;
      const timeOffset = globalIndex * SPLIT_THRESHOLD;
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
