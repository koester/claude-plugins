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
// Rolling buffer of the current turn's displayed assistant text, fed by the MessageDisplay hook so
// a following AskUserQuestion prompt can be read together with the text that preceded it.
const BUFFER_PATH = path.join(DIR, 'preamble-buffer.txt');
// The latest read wins: every new read stamps a fresh epoch here; a worker whose epoch is stale
// bows out before its next chunk, so reads never overlap or play out of order.
const EPOCH_PATH = path.join(DIR, 'epoch');

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
  stopOnPrompt: true, // stop any playing audio the moment you submit your next prompt
  readOptions: true, // read AskUserQuestion prompts (question + options) aloud — Stop won't fire for those
  readOptionDescriptions: true, // include each option's description, not only its label
  readPreamble: true, // read the assistant text shown before a prompt (captured via MessageDisplay)
  skipCodeBlocks: true, // drop fenced code blocks entirely (reading code aloud is useless)
  outputFormat: 'mp3_44100_128',
  chunkChars: 2000, // max characters per TTS request/audio segment (keeps well under API limits)
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

// Turn an AskUserQuestion tool_input into a natural spoken script of the question(s) and options.
function textFromAskUserQuestion(toolInput, cfg) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (!questions.length) return '';
  const parts = [];
  const multi = questions.length > 1;
  questions.forEach((q, qi) => {
    if (multi) parts.push(`Question ${qi + 1}.`);
    if (q.question) parts.push(q.question);
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length) {
      parts.push('Your options are:');
      const trim = (v) => String(v).replace(/[.!?]+$/, ''); // avoid doubled sentence punctuation
      opts.forEach((o, oi) => {
        let s = `${oi + 1}. ${trim(o.label)}.`;
        if (cfg.readOptionDescriptions !== false && o.description) s += ` ${trim(o.description)}.`;
        parts.push(s);
      });
    }
  });
  return parts.join(' ');
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

async function synthesizeAndPlay(text, cfg, epoch) {
  // Debug aid: YAPPER_DRY=1 prints the final would-be-spoken text (incl. any prepended preamble).
  if (process.env.YAPPER_DRY) {
    process.stderr.write(`[yapper dry] ${text}\n`);
    return;
  }
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

  // If a newer read has started, this one is stale — stop so reads never overlap or misorder.
  const superseded = () => epoch && currentEpoch() !== epoch;
  const chunks = chunkText(text, Math.max(200, cfg.chunkChars || 2000));

  for (const chunk of chunks) {
    if (superseded()) return;

    let audio;
    try {
      audio = await synthesize(chunk, cfg, key, voiceId);
    } catch (e) {
      if (e.status === 402) {
        log(
          `voice ${voiceId} needs a paid ElevenLabs plan — library/cloned voices require a paid ` +
            `subscription. Pick a free premade voice with "yapper voices" (e.g. Brian), or upgrade.`,
        );
        return;
      }
      const voiceError = [400, 404, 422].includes(e.status);
      if (voiceError && !explicitVoice) {
        // The auto-picked voice went stale — refetch the first available and retry this chunk once.
        try {
          const voices = await fetchVoices(key);
          if (!voices.length) throw e;
          voiceId = voices[0].id;
          const saved = loadConfig();
          saved.voiceId = voiceId;
          saveConfig(saved);
          audio = await synthesize(chunk, cfg, key, voiceId);
        } catch (e2) {
          log(`TTS failed after voice retry: ${e2.message}`);
          return;
        }
      } else if (voiceError) {
        // Don't silently swap a voice the user chose on purpose — tell them how to fix it.
        log(
          `TTS failed for voice ${voiceId} (${e.status}). If it's a Voice Library voice, add it to ` +
            `your account first (elevenlabs.io → Voice Library → "Add to My Voices"), then retry.`,
        );
        return;
      } else {
        log(`TTS failed: ${e.message}`);
        return;
      }
    }

    if (superseded()) return; // a newer read arrived during synthesis — don't play this chunk
    const tmp = path.join(
      os.tmpdir(),
      `yapper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
    );
    try {
      fs.writeFileSync(tmp, audio);
    } catch (e) {
      log(`write audio failed: ${e.message}`);
      return;
    }
    await play(tmp, cfg);
  }
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

  stageAndSpawn(text, cfg);
}

// ---------- preamble buffer (fed by MessageDisplay, consumed by the AskUserQuestion hook) ----------

function appendPreamble(delta) {
  try {
    ensureDir();
    fs.appendFileSync(BUFFER_PATH, delta);
  } catch {
    /* best-effort */
  }
}

function readPreambleBuffer() {
  try {
    return fs.readFileSync(BUFFER_PATH, 'utf8');
  } catch {
    return '';
  }
}

function clearPreambleBuffer() {
  try {
    fs.unlinkSync(BUFFER_PATH);
  } catch {
    /* already gone */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The MessageDisplay --capture hooks write asynchronously and can lag; wait briefly for the buffer
// to stop growing so we read the whole preamble, not a partial/empty one. Runs in the detached
// worker (after the prompt is already on screen), so it never delays the prompt.
async function waitForBufferStable(maxMs = 600, stepMs = 60) {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < maxMs) {
    let size = 0;
    try {
      size = fs.statSync(BUFFER_PATH).size;
    } catch {
      size = 0;
    }
    if (size === last) {
      if (++stable >= 2 && size > 0) return;
    } else {
      stable = 0;
      last = size;
    }
    await sleep(stepMs);
  }
}

// ---------- read ordering (epoch) + chunking ----------

// Stamp a new "latest read" token. Older workers see a different value and stop.
function bumpEpoch() {
  const e = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    ensureDir();
    fs.writeFileSync(EPOCH_PATH, e);
  } catch {
    /* best-effort */
  }
  return e;
}

function currentEpoch() {
  try {
    return fs.readFileSync(EPOCH_PATH, 'utf8');
  } catch {
    return '';
  }
}

// Split long text into API-safe pieces at sentence (then word) boundaries, preserving order.
function chunkText(text, limit) {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const chunks = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('. ', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit); // no sentence break → word break
    if (cut <= 0) cut = limit; // no break at all → hard cut
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Hand text to a detached worker and return immediately so the hook never blocks the session.
function stageAndSpawn(text, cfg, opts = {}) {
  // When prepending the preamble, the worker resolves it (with a buffer-stable wait) — so a dry run
  // of the hook can't show it here; dry-run the worker directly to see the combined text.
  if (process.env.YAPPER_DRY && !opts.prependPreamble) {
    process.stderr.write(`[yapper dry] ${text}\n`);
    return;
  }
  ensureDir();
  const epoch = bumpEpoch(); // mark this as the latest read so any in-flight worker bows out
  if (!cfg || cfg.interrupt !== false) killCurrent(); // silence the previous read immediately
  const textFile = path.join(DIR, `pending-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(textFile, text);
  } catch (e) {
    log(`could not stage text: ${e.message}`);
    return;
  }
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--worker', textFile, epoch, opts.prependPreamble ? '1' : '0'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

// PreToolUse(AskUserQuestion) hook: Stop never fires for a question prompt (the turn is mid-tool),
// so read the question + its options — and the assistant text shown just before it — aloud here.
async function runTool() {
  const cfg = loadConfig();
  if (!cfg.enabled || cfg.readOptions === false) return;

  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    /* no/invalid payload */
  }
  if (payload?.tool_name !== 'AskUserQuestion') return;

  const text = cleanForSpeech(textFromAskUserQuestion(payload.tool_input, cfg), cfg);
  if (!text || text.length < 2) {
    clearPreambleBuffer();
    return;
  }

  // Return fast so the prompt isn't delayed; the worker prepends the MessageDisplay-captured
  // preamble (after waiting for it to settle) and speaks it.
  stageAndSpawn(text, cfg, { prependPreamble: cfg.readPreamble !== false });
}

async function runWorker(textFile, epoch, prependPreamble) {
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
  if (!text) return;

  // Prefix the preamble captured live by MessageDisplay. Reading it here (not in the PreToolUse
  // hook) lets us wait for the async capture to settle without delaying the prompt.
  if (prependPreamble === '1' && cfg.readPreamble !== false) {
    await waitForBufferStable();
    const pre = cleanForSpeech(readPreambleBuffer(), cfg);
    clearPreambleBuffer();
    if (pre) {
      const cap = Math.max(200, (cfg.maxChars || 1000) - 300); // leave room for the options
      text = `${pre.length > cap ? pre.slice(0, cap) : pre} ${text}`;
    }
  }

  await synthesizeAndPlay(text, cfg, epoch);
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
    case 'stop':
    case 'shush':
    case 'quiet':
    case 'hush':
      // Silence whatever is playing right now, without disabling Yapper.
      killCurrent();
      console.log('playback stopped');
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
      console.log('  stop                silence current playback (alias: shush)');
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
  // Stop = turn ended; clear the preamble buffer so it never leaks into the next turn.
  runHook()
    .catch((e) => log(`hook error: ${e.message}`))
    .finally(() => clearPreambleBuffer());
} else if (argv[0] === '--worker') {
  runWorker(argv[1], argv[2], argv[3]).catch((e) => log(`worker error: ${e.message}`));
} else if (argv[0] === '--tool') {
  runTool().catch((e) => log(`tool hook error: ${e.message}`));
} else if (argv[0] === '--interrupt') {
  // UserPromptSubmit hook: silence playback and start a fresh preamble buffer for the new turn.
  // Must write NOTHING to stdout — UserPromptSubmit stdout is injected into the prompt.
  try {
    if (loadConfig().stopOnPrompt !== false) killCurrent();
    clearPreambleBuffer();
  } catch (e) {
    log(`interrupt error: ${e.message}`);
  }
} else if (argv[0] === '--capture') {
  // MessageDisplay hook: accumulate the assistant's displayed text (payload.delta) so the next
  // AskUserQuestion prompt can be read together with it. Silent; writes only to the buffer file.
  readStdin().then((raw) => {
    try {
      const cfg = loadConfig();
      if (!cfg.enabled || cfg.readOptions === false || cfg.readPreamble === false) return;
      const p = JSON.parse(raw);
      if (typeof p?.delta === 'string' && p.delta) appendPreamble(p.delta);
    } catch {
      /* best-effort */
    }
  });
} else {
  runCli(argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
