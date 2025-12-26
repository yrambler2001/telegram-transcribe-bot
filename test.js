import { processFile } from './transcribe.js';

processFile('./voice_messages/voice.ogg', 'uk')
  .then(({ formattedTranscript }) => {
    console.log(formattedTranscript);
  })
  .catch((e) => {
    console.log(e);
  });
