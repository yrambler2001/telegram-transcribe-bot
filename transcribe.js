import path from 'path';
import { v2 as speech } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import { BUCKET_NAME, GCS_TRANSCRIPTS_PREFIX, GCS_AUDIO_FILES_PREFIX, GOOGLE_KEY_PATH } from './config.js';

const { SpeechClient } = speech;

const speechClient = new SpeechClient({
  keyFilename: GOOGLE_KEY_PATH,
  apiEndpoint: 'us-speech.googleapis.com',
});

const storageClient = new Storage({ keyFilename: GOOGLE_KEY_PATH });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatTime(secondsString) {
  if (!secondsString) return '[00:00]';
  const totalSeconds = parseFloat(secondsString.replace('s', ''));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
}

const langMap = {
  uk: 'uk-UA',
  en: 'en-US',
  pl: 'pl-PL',
  ru: 'ru-RU',
};
export async function processFile(filename, lang = 'uk') {
  console.log(`transcribing ${filename} ${lang}`);
  const projectId = await speechClient.getProjectId();
  const localPath = filename;
  const { name } = path.parse(filename);
  const gcsAudioUri = `gs://${BUCKET_NAME}/${GCS_AUDIO_FILES_PREFIX}${name}`;
  const gcsOutputUri = `gs://${BUCKET_NAME}/${GCS_TRANSCRIPTS_PREFIX}`;

  try {
    console.log(`⬆️ Uploading: ${filename}...`);
    await storageClient.bucket(BUCKET_NAME).upload(localPath, {
      destination: `${GCS_AUDIO_FILES_PREFIX}${name}`,
    });

    const recognizerName = `projects/${projectId}/locations/us/recognizers/_`;

    const request = {
      recognizer: recognizerName,
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

    // --- RETRY LOGIC (Enhanced) ---
    let operation;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (true) {
      try {
        // console.log(`🤖 Transcribing (Attempt ${retries + 1}): ${filename}...`);
        const [op] = await speechClient.batchRecognize(request);
        operation = op;
        break;
      } catch (err) {
        // Code 8 = RESOURCE_EXHAUSTED
        if (err.code === 8 && retries < MAX_RETRIES) {
          // Wait 60 seconds (Longer wait to let quota refill)
          const waitTime = 60000 + Math.random() * 5000;
          console.warn(`⏳ Quota exceeded on ${filename}. Pausing 60s before retry...`);
          await sleep(waitTime);
          retries++;
        } else {
          throw err;
        }
      }
    }

    console.log(`⏳ processing... ${filename}`);
    const [response] = await operation.promise();

    const fileResult = response.results[gcsAudioUri];
    if (!fileResult) throw new Error('Google returned no result.');
    if (fileResult.error) throw new Error(`Google Cloud Error: ${fileResult.error.message}`);

    const resultUri = fileResult.cloudStorageResult?.jsonResult?.uri || fileResult.cloudStorageResult?.uri;

    if (!resultUri) throw new Error('Output URI is missing.');

    const outputFileName = resultUri.replace(`gs://${BUCKET_NAME}/`, '');
    const [tempFile] = await storageClient.bucket(BUCKET_NAME).file(outputFileName).download();
    const jsonResponse = JSON.parse(tempFile.toString());

    // --- PARSING ---
    const allWords = jsonResponse.results.flatMap((r) => r.alternatives[0].words || []);
    let formattedTranscript = '';
    let currentLine = '';
    let currentLineStartTime = null;

    allWords.forEach((wordObj, index) => {
      const { word } = wordObj;
      const start = wordObj.startOffset || '0s';
      if (currentLine === '') currentLineStartTime = start;
      currentLine += `${word} `;
      const isSentenceEnd = /[.!?]$/.test(word);
      const isComma = /[,]$/.test(word);
      const isLong = currentLine.length > 100;
      if (isSentenceEnd || (isLong && isComma) || index === allWords.length - 1) {
        formattedTranscript += `${formatTime(currentLineStartTime)} ${currentLine.trim()}\n`;
        currentLine = '';
        currentLineStartTime = null;
      }
    });
    await Promise.all([
      storageClient.bucket(BUCKET_NAME).file(`${GCS_AUDIO_FILES_PREFIX}${name}`).delete(),
      storageClient.bucket(BUCKET_NAME).file(outputFileName).delete(),
    ]);
    console.log(`Processed ${filename}`);

    return { formattedTranscript, jsonResponse };
  } catch (err) {
    console.error(`❌ Error on ${filename}:`, err.message);
  }
}
