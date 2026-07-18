#!/usr/bin/env node
// Yapper — reads Claude Code's completed responses aloud via ElevenLabs TTS.
//
// Three modes, dispatched by the first argument:
//   node yapper.mjs --hook            Stop-hook entry: reads the hook payload from stdin,
//                                      pulls the last assistant message out of the transcript,
//                                      hands it to a detached worker, and exits immediately so
//                                      the hook never blocks the next prompt.
//   node yapper.mjs --worker <file>   Detached worker: synthesize the text in <file> and play it.
//   node yapper.mjs <command> [args]  Control CLI: status | on | off | toggle | test | voices |
//                                      voice <id|name> | model <id> | maxchars <n> | speed <x>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'yapper');
const CONFIG_PATH = path.join(DIR, 'config.json');
const PID_PATH = path.join(DIR, 'current.pid');
const LOG_PATH = path.join(DIR, 'yapper.log');

// Config lives outside the plugin directory so it survives plugin updates.
const DEFAULTS = {
  enabled: true,
  // Brian — a free premade voice available on every ElevenLabs account. Swap it for any voice
  // id (or name) via `/yapper voice <id|name>` or by editing this field. Library/cloned voices
  // work too, as long as your plan/key is allowed to use them. Set to '' to auto-pick the first
  // voice on your account.
  voiceId: 'nPczCjzI2devNBz1zQrb',
  modelId: 'eleven_flash_v2_5', // fastest/cheapest multilingual model; good for reading responses
  maxChars: 1000, // cap so a long answer doesn't turn into a monologue (and to bound API cost)
  stability: 0.5,
  similarityBoost: 0.75,
  speed: 1.0, // 0.5–2.0; only sent to the API when != 1.0 for older-model compatibility
  interrupt: true, // stop the previous message's audio when a new one starts
  skipCodeBlocks: true, // drop fenced code blocks entirely (reading code aloud is useless)
  outputFormat: 'mp3_44100_128',
  playerCmd: null, // override the audio player; default: afplay on macOS, ffplay elsewhere
  playerArgs: null,
  apiKey: '', // optional: store the ElevenLabs key here if you don't export it as an env var
};

// ---------- small utilities ----------

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function log(msg) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging is best-effort */
  }
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// An explicitly configured key wins over the ambient environment (a deliberate config choice
// beats whatever stale ELEVENLABS_API_KEY might be lingering in the shell/process).
function apiKey(cfg) {
  return cfg?.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '';
}

// ---------- transcript extraction + speech cleanup ----------

// Walk the transcript JSONL backwards and return the text of the most recent assistant
// message that actually contains text blocks (skipping trailing tool_use / thinking lines).
function extractLastAssistantText(transcriptPath) {
  let data;
  try {
    data = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text);
    if (texts.length) return texts.join('\n\n');
    // assistant line with only tool_use/thinking → keep looking further back in the turn
  }
  return '';
}

// Strip markdown down to something that sounds natural when spoken.
function cleanForSpeech(input, cfg) {
  let t = input;
  t = t.replace(/```[\s\S]*?```/g, cfg.skipCodeBlocks ? ' ' : ' code block. ');
  t = t.replace(/`([^`]+)`/g, '$1'); // inline code → its contents
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images → alt text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links → link text
  t = t.replace(/https?:\/\/\S+/g, ' link '); // bare URLs
  t = t.replace(/^\s*#{1,6}\s+/gm, ''); // headers
  t = t.replace(/^\s*>\s?/gm, ''); // blockquotes
  t = t.replace(/^\s*[-*+]\s+/gm, ''); // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, ''); // numbered list markers
  t = t.replace(/~~([^~]+)~~/g, '$1'); // strikethrough
  t = t.replace(/(\*\*|__|\*|_)/g, ''); // bold/italic markers
  t = t.replace(/\|/g, ' '); // table pipes
  t = t.replace(/^\s*([-=_*]\s*){3,}$/gm, ' '); // horizontal rules
  t = t.replace(/\s+/g, ' ').trim(); // collapse whitespace
  if (t.length > cfg.maxChars) {
    t = t.slice(0, cfg.maxChars);
    // prefer cutting at a sentence boundary in the back half
    const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    if (cut > cfg.maxChars * 0.5) t = t.slice(0, cut + 1);
  }
  return t;
}

// ---------- audio playback ----------

function pickPlayer(cfg) {
  if (cfg.playerCmd) return { cmd: cfg.playerCmd, pre: cfg.playerArgs || [] };
  if (process.platform === 'darwin') return { cmd: 'afplay', pre: [] };
  return { cmd: 'ffplay', pre: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] };
}

function killCurrent() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no current playback */
  }
}

function play(file, cfg) {
  return new Promise((resolve) => {
    const { cmd, pre } = pickPlayer(cfg);
    let child;
    try {
      child = spawn(cmd, [...pre, file], { stdio: 'ignore' });
    } catch (e) {
      log(`player spawn failed: ${e.message}`);
      return resolve();
    }
    try {
      fs.writeFileSync(PID_PATH, String(child.pid));
    } catch {
      /* ignore */
    }
    child.on('error', (e) => {
      log(`player error: ${e.message}`);
      resolve();
    });
    child.on('exit', () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(PID_PATH);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

// ---------- ElevenLabs API ----------

async function fetchVoices(key) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': key },
  });
  if (!res.ok) throw new Error(`voices request failed: ${res.status}`);
  const data = await res.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
}

async function synthesize(text, cfg, key, voiceId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${encodeURIComponent(
    cfg.outputFormat,
  )}`;
  const voiceSettings = { stability: cfg.stability, similarity_boost: cfg.similarityBoost };
  if (cfg.speed && cfg.speed !== 1.0) voiceSettings.speed = cfg.speed;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: cfg.modelId, voice_settings: voiceSettings }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`TTS ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function resolveVoiceId(cfg, key) {
  if (cfg.voiceId) return cfg.voiceId;
  const voices = await fetchVoices(key);
  if (!voices.length) throw new Error('no voices available on this account');
  const saved = loadConfig();
  saved.voiceId = voices[0].id;
  saveConfig(saved);
  log(`auto-selected voice ${voices[0].name} (${voices[0].id})`);
  return voices[0].id;
}

async function synthesizeAndPlay(text, cfg) {
  const key = apiKey(cfg);
  if (!key) {
    log('no API key — set ELEVENLABS_API_KEY or add "apiKey" to the config');
    return;
  }
  if (!text) return;

  const explicitVoice = !!cfg.voiceId; // did the user pick this voice on purpose?
  let voiceId;
  try {
    voiceId = await resolveVoiceId(cfg, key);
  } catch (e) {
    log(`voice resolve failed: ${e.message}`);
    return;
  }

  let audio;
  try {
    audio = await synthesize(text, cfg, key, voiceId);
  } catch (e) {
    if (e.status === 402) {
      log(
        `voice ${voiceId} needs a paid ElevenLabs plan — library/cloned voices require a paid ` +
          `subscription. Pick a free premade voice with "yapper voices" (e.g. Brian), or upgrade.`,
      );
      return;
    }
    const voiceError = [400, 404, 422].includes(e.status);
    if (voiceError && explicitVoice) {
      // Don't silently swap a voice the user chose on purpose — tell them how to fix it.
      log(
        `TTS failed for voice ${voiceId} (${e.status}). If it's a Voice Library voice, add it to ` +
          `your account first (elevenlabs.io → Voice Library → "Add to My Voices"), then retry.`,
      );
      return;
    }
    if (voiceError) {
      // The auto-picked voice went stale — refetch the first available and retry once.
      try {
        const voices = await fetchVoices(key);
        if (!voices.length) throw e;
        voiceId = voices[0].id;
        const saved = loadConfig();
        saved.voiceId = voiceId;
        saveConfig(saved);
        audio = await synthesize(text, cfg, key, voiceId);
      } catch (e2) {
        log(`TTS failed after voice retry: ${e2.message}`);
        return;
      }
    } else {
      log(`TTS failed: ${e.message}`);
      return;
    }
  }

  const tmp = path.join(os.tmpdir(), `yapper-${process.pid}-${Date.now()}.mp3`);
  try {
    fs.writeFileSync(tmp, audio);
  } catch (e) {
    log(`write audio failed: ${e.message}`);
    return;
  }
  await play(tmp, cfg);
}

// ---------- stdin ----------

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

// ---------- modes ----------

async function runHook() {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    /* no/invalid payload */
  }

  // Prefer the message the hook hands us directly; fall back to parsing the transcript.
  let raw = typeof payload?.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  if (!raw && payload?.transcript_path) raw = extractLastAssistantText(payload.transcript_path);
  if (!raw) {
    log('no assistant text found (no last_assistant_message and no transcript)');
    return;
  }

  const text = cleanForSpeech(raw, cfg);
  if (!text || text.length < 2) return;

  if (cfg.interrupt) killCurrent();

  // Hand the text to a detached worker and return immediately so the hook never blocks.
  ensureDir();
  const textFile = path.join(DIR, `pending-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(textFile, text);
  } catch (e) {
    log(`could not stage text: ${e.message}`);
    return;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', textFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function runWorker(textFile) {
  const cfg = loadConfig();
  let text = '';
  try {
    text = fs.readFileSync(textFile, 'utf8');
  } catch {
    /* nothing to say */
  }
  try {
    fs.unlinkSync(textFile);
  } catch {
    /* ignore */
  }
  if (text) await synthesizeAndPlay(text, cfg);
}

async function runCli(argv) {
  const [rawCmd, ...rest] = argv;
  const cmd = (rawCmd || 'status').toLowerCase();
  const cfg = loadConfig();

  switch (cmd) {
    case 'status': {
      const keySrc = cfg.apiKey
        ? 'config file'
        : process.env.ELEVENLABS_API_KEY
          ? 'env ELEVENLABS_API_KEY'
          : process.env.XI_API_KEY
            ? 'env XI_API_KEY'
            : '';
      console.log(`Yapper: ${cfg.enabled ? 'ON' : 'OFF'}`);
      console.log(
        `  API key:   ${keySrc ? 'set (' + keySrc + ')' : 'MISSING (set ELEVENLABS_API_KEY or config apiKey)'}`,
      );
      console.log(`  voice:     ${cfg.voiceId || '(auto — first account voice)'}`);
      console.log(`  model:     ${cfg.modelId}`);
      console.log(`  maxChars:  ${cfg.maxChars}`);
      console.log(`  speed:     ${cfg.speed}`);
      console.log(`  interrupt: ${cfg.interrupt}`);
      console.log(`  config:    ${CONFIG_PATH}`);
      break;
    }
    case 'on':
    case 'enable':
      cfg.enabled = true;
      saveConfig(cfg);
      console.log('Yapper ON');
      break;
    case 'off':
    case 'disable':
      cfg.enabled = false;
      saveConfig(cfg);
      killCurrent();
      console.log('Yapper OFF');
      break;
    case 'toggle':
      cfg.enabled = !cfg.enabled;
      saveConfig(cfg);
      if (!cfg.enabled) killCurrent();
      console.log(`Yapper ${cfg.enabled ? 'ON' : 'OFF'}`);
      break;
    case 'test': {
      if (!apiKey(cfg)) {
        console.log('ELEVENLABS_API_KEY is not set.');
        break;
      }
      const text =
        rest.join(' ') ||
        'Yapper is working. This is a test of the Eleven Labs text to speech voice.';
      console.log('Speaking test phrase…');
      await synthesizeAndPlay(cleanForSpeech(text, cfg), cfg);
      break;
    }
    case 'preview': {
      // Print what would be spoken for a given transcript file — no API call. Handy for debugging.
      const tp = rest.join(' ').trim();
      if (!tp) {
        console.log('usage: yapper preview <transcript.jsonl>');
        break;
      }
      const raw = extractLastAssistantText(tp);
      if (!raw) {
        console.log('(no assistant text found in that transcript)');
        break;
      }
      const spoken = cleanForSpeech(raw, cfg);
      console.log(`--- would speak (${spoken.length} chars) ---`);
      console.log(spoken);
      break;
    }
    case 'voices': {
      if (!apiKey(cfg)) {
        console.log('ELEVENLABS_API_KEY is not set.');
        break;
      }
      const voices = await fetchVoices(apiKey(cfg));
      console.log(`${voices.length} voice(s) on this account:`);
      for (const v of voices) {
        const mark = v.id === cfg.voiceId ? '➤ ' : '  ';
        const desc = [v.labels?.accent, v.labels?.gender, v.labels?.description]
          .filter(Boolean)
          .join(', ');
        console.log(`${mark}${v.name.padEnd(18)} ${v.id}${desc ? '  (' + desc + ')' : ''}`);
      }
      break;
    }
    case 'voice': {
      const arg = rest.join(' ').trim();
      if (!arg) {
        console.log(`current voice: ${cfg.voiceId || '(auto)'}`);
        break;
      }
      // A raw voice id (long alphanumeric) is used as-is; otherwise resolve by name.
      if (/^[A-Za-z0-9]{15,}$/.test(arg)) {
        cfg.voiceId = arg;
        saveConfig(cfg);
        console.log(`voice set to ${arg}`);
        break;
      }
      if (!apiKey(cfg)) {
        console.log('ELEVENLABS_API_KEY is not set (needed to resolve a voice by name).');
        break;
      }
      const voices = await fetchVoices(apiKey(cfg));
      const match =
        voices.find((v) => v.name.toLowerCase() === arg.toLowerCase()) ||
        voices.find((v) => v.name.toLowerCase().includes(arg.toLowerCase()));
      if (!match) {
        console.log(`no voice matching "${arg}" — run: yapper voices`);
        break;
      }
      cfg.voiceId = match.id;
      saveConfig(cfg);
      console.log(`voice set to ${match.name} (${match.id})`);
      break;
    }
    case 'model': {
      const arg = rest.join(' ').trim();
      if (!arg) {
        console.log(`current model: ${cfg.modelId}`);
        break;
      }
      cfg.modelId = arg;
      saveConfig(cfg);
      console.log(`model set to ${arg}`);
      break;
    }
    case 'maxchars': {
      const n = parseInt(rest[0], 10);
      if (Number.isFinite(n) && n > 0) {
        cfg.maxChars = n;
        saveConfig(cfg);
        console.log(`maxChars set to ${n}`);
      } else {
        console.log(`current maxChars: ${cfg.maxChars}`);
      }
      break;
    }
    case 'speed': {
      const n = parseFloat(rest[0]);
      if (Number.isFinite(n) && n >= 0.5 && n <= 2.0) {
        cfg.speed = n;
        saveConfig(cfg);
        console.log(`speed set to ${n}`);
      } else {
        console.log(`current speed: ${cfg.speed} (allowed range 0.5–2.0)`);
      }
      break;
    }
    default:
      console.log('Yapper — read Claude responses aloud with ElevenLabs.');
      console.log('Usage: yapper <command>');
      console.log('  status              show current settings');
      console.log('  on | off | toggle   enable/disable speaking');
      console.log('  test [text]         speak a test phrase');
      console.log('  voices              list available ElevenLabs voices');
      console.log('  voice <id|name>     set the voice');
      console.log('  model <id>          set the model (e.g. eleven_flash_v2_5)');
      console.log('  maxchars <n>        cap characters spoken per message');
      console.log('  speed <0.5-2.0>     set speaking speed');
      break;
  }
}

// ---------- dispatch ----------

const argv = process.argv.slice(2);
if (argv[0] === '--hook') {
  runHook().catch((e) => log(`hook error: ${e.message}`));
} else if (argv[0] === '--worker') {
  runWorker(argv[1]).catch((e) => log(`worker error: ${e.message}`));
} else {
  runCli(argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
