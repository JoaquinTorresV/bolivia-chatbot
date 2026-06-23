import { writeFileSync, unlinkSync, existsSync, createReadStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import OpenAI from 'openai';

// Whisper de OpenAI — ~$0.006 por minuto
// Si no hay API key configurada, la transcripcion devuelve null (audio queda ignorado)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 }) // 60s max
  : null;

const FETCH_TIMEOUT_MS = 30_000; // 30s para bajar el audio de YCloud
const MAX_AUDIO_BYTES  = 24 * 1024 * 1024; // 24MB (Whisper acepta hasta 25MB)

export async function transcribeAudio(audioUrl) {
  if (!openai) {
    console.warn('[transcribe] OPENAI_API_KEY no configurada, audio ignorado');
    return null;
  }

  let tmpPath = null;
  try {
    // descarga con timeout via AbortController
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(audioUrl, {
        headers: { 'X-API-Key': process.env.YCLOUD_API_KEY },
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      console.error(`[transcribe] download fallo ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // limite de tamaño antes de mandar a Whisper
    if (buffer.length > MAX_AUDIO_BYTES) {
      console.warn(`[transcribe] audio muy grande (${(buffer.length/1024/1024).toFixed(1)}MB), excede 24MB`);
      return null;
    }

    console.log(`[transcribe] procesando audio de ${(buffer.length/1024).toFixed(0)}KB`);
    tmpPath = join(tmpdir(), `audio_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);
    writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file:     createReadStream(tmpPath),
      model:    'whisper-1',
      language: 'es',
    });

    const text = transcription.text || null;
    console.log(`[transcribe] OK (${text?.length || 0} chars)`);
    return text;
  } catch (err) {
    console.error('[transcribe] error:', err.message);
    return null;
  } finally {
    if (tmpPath && existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignorar */ }
    }
  }
}
