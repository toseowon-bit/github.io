#!/usr/bin/env node
// Generates the AI-voice MP3s for the 200 sentences with Google Cloud Text-to-Speech.
//
//   GOOGLE_TTS_API_KEY=... node scripts/generate-tts.mjs list [en-US]        # list available voices
//   GOOGLE_TTS_API_KEY=... node scripts/generate-tts.mjs samples <dir> <voice name>...
//   GOOGLE_TTS_API_KEY=... node scripts/generate-tts.mjs build               # audio/<key>/<id>.mp3 + audio/voices.json
//   GOOGLE_TTS_API_KEY=... node scripts/generate-tts.mjs recheck             # build, also redoing existing cut-off files
//
// `build` reads scripts/tts-voices.json, skips files that already exist, and rewrites
// audio/voices.json, which the app uses to show its "AI 음성" options.
// Chirp3-HD voices sometimes stop mid-word, so their takes are checked with ffmpeg (if installed)
// and re-synthesized until they end in silence.
// Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://texttospeech.googleapis.com/v1';
const PREVIEW_TEXT = "Hi there! Let's practice English together."; // keep in sync with index.html
const SAMPLE_TEXT = "I lost track of time. Can we push it back an hour?";
const CONCURRENCY = 4;
const CUT_OFF_DB = -50; // RMS of a take's last 40ms; louder means it ended mid-speech
const ATTEMPTS = 10;    // the second half adds a trailing pause, which often lets the voice finish

const apiKey = process.env.GOOGLE_TTS_API_KEY;
if (!apiKey) {
    console.error('GOOGLE_TTS_API_KEY is not set.');
    process.exit(1);
}

async function api(path, init = {}) {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${API}${path}`, {
            ...init,
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, ...init.headers },
        });
        if (res.ok) return res.json();
        const body = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < 5) {
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            continue;
        }
        throw new Error(`${res.status} ${path}: ${body}`);
    }
}

async function synthesize(input, voiceName) {
    const languageCode = voiceName.split('-').slice(0, 2).join('-');
    const { audioContent } = await api('/text:synthesize', {
        method: 'POST',
        body: JSON.stringify({
            input,
            voice: { languageCode, name: voiceName },
            audioConfig: { audioEncoding: 'MP3' },
        }),
    });
    return Buffer.from(audioContent, 'base64');
}

let warnedNoFfmpeg = false;

// RMS level (dB) of the last 40ms of an MP3, or null when ffmpeg is unavailable
function tailDb(audio) {
    const { stderr, error } = spawnSync('ffmpeg', ['-hide_banner', '-i', 'pipe:0',
        '-af', 'areverse,atrim=0:0.04,astats=metadata=0', '-f', 'null', '-'], { input: audio });
    if (error) {
        if (!warnedNoFfmpeg) console.warn('ffmpeg not found: skipping the cut-off check');
        warnedNoFfmpeg = true;
        return null;
    }
    const level = stderr.toString().match(/RMS level dB: (\S+)/)?.[1];
    return level === undefined || level === '-inf' ? -Infinity : Number(level);
}

function isCutOff(audio, voiceName) {
    return voiceName.includes('Chirp3') && (tailDb(audio) ?? -Infinity) > CUT_OFF_DB;
}

// Synthesizes `text`, retrying takes that end mid-speech; keeps the quietest ending if none is clean
async function synthesizeWhole(text, voiceName) {
    let best = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const input = attempt < ATTEMPTS / 2 ? { text } : { markup: `${text} [pause short]` };
        const audio = await synthesize(input, voiceName);
        const db = voiceName.includes('Chirp3') ? tailDb(audio) : null;
        if (db === null || db <= CUT_OFF_DB) return audio;
        if (!best || db < best.db) best = { audio, db };
    }
    console.warn(`  still cut off after ${ATTEMPTS} attempts: ${voiceName} "${text}"`);
    return best.audio;
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function loadSentences() {
    const html = await readFile(join(ROOT, 'index.html'), 'utf8');
    const sentences = [...html.matchAll(/\{ id: (\d+), kr: "(?:[^"\\]|\\.)*", en: "((?:[^"\\]|\\.)*)" \}/g)]
        .map(m => ({ id: Number(m[1]), en: JSON.parse(`"${m[2]}"`) }));
    if (sentences.length !== 200) throw new Error(`Expected 200 sentences in index.html, found ${sentences.length}`);
    return sentences;
}

async function runPool(tasks) {
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < tasks.length) await tasks[next++]();
    }));
}

async function list(languageCode = 'en-US') {
    const { voices } = await api(`/voices?languageCode=${encodeURIComponent(languageCode)}`);
    for (const v of voices.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`${v.name}\t${v.ssmlGender}\t${v.languageCodes.join(',')}`);
    }
}

async function samples(dir, voiceNames) {
    await mkdir(dir, { recursive: true });
    for (const name of voiceNames) {
        await writeFile(join(dir, `${name}.mp3`), await synthesizeWhole(SAMPLE_TEXT, name));
        console.log(`wrote ${join(dir, `${name}.mp3`)}`);
    }
}

// recheck: also re-synthesize existing files that were cut off
async function build({ recheck = false } = {}) {
    const voices = JSON.parse(await readFile(join(ROOT, 'scripts', 'tts-voices.json'), 'utf8'));
    const sentences = await loadSentences();
    for (const voice of voices) {
        const outDir = join(ROOT, 'audio', voice.key);
        await mkdir(outDir, { recursive: true });
        const jobs = [{ file: 'preview', text: PREVIEW_TEXT }, ...sentences.map(s => ({ file: String(s.id), text: s.en }))];
        let written = 0;
        await runPool(jobs.map(job => async () => {
            const path = join(outDir, `${job.file}.mp3`);
            if (await exists(path) && !(recheck && isCutOff(await readFile(path), voice.googleVoice))) return;
            await writeFile(path, await synthesizeWhole(job.text, voice.googleVoice));
            written++;
        }));
        console.log(`${voice.key} (${voice.googleVoice}): ${written} new files`);
    }
    const manifest = { voices: voices.map(({ key, label, accent, gender }) => ({ key, label, accent, gender })) };
    await writeFile(join(ROOT, 'audio', 'voices.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('wrote audio/voices.json');
}

const [command, ...args] = process.argv.slice(2);
if (command === 'list') await list(args[0]);
else if (command === 'samples' && args.length >= 2) await samples(args[0], args.slice(1));
else if (command === 'build') await build();
else if (command === 'recheck') await build({ recheck: true });
else {
    console.error('Usage: generate-tts.mjs list [languageCode] | samples <dir> <voice>... | build | recheck');
    process.exit(1);
}
