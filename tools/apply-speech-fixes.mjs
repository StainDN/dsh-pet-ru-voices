#!/usr/bin/env node
/**
 * Озвучка dsh-pet: чистка разметки и фраза в конце задачи.
 *
 * Две правки, обе — про то, что слышно:
 *   1. Перед синтезом из текста убираются ролевые *действия*, тильды и markdown-маркеры
 *      (иначе голос читает «звёздочка», «тильда» и обрывки действий).
 *   2. Терминальный статус задачи (success / error) проговаривается фразой из workStatusTexts —
 *      раньше в конце задачи показывался только пузырь, без звука.
 *
 * Идемпотентно, с бэкапом. После установки нужен перезапуск helper'а (или DSH).
 *
 * Использование:
 *   node apply-speech-fixes.mjs [--dry-run] [--package <path>]
 *   node apply-speech-fixes.mjs --revert
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = '.speech-fixes-backup';

const SANITIZER_JS = [
  '/** Чистка текста перед озвучкой: ролевые *действия*, тильды и markdown-маркеры не читаем. */',
  'function sanitizeForSpeech(text) {',
  '\tconst raw = String(text ?? "");',
  '\tlet out = raw',
  '\t\t.replace(/\\*[^*]*\\*/g, " ")',
  '\t\t.replace(/[*~`]/g, " ")',
  '\t\t.replace(/\\s+/g, " ")',
  '\t\t.replace(/\\s+([,.!?;:…])/g, "$1")',
  '\t\t.trim();',
  '\tif (out === "") out = raw.replace(/[*~`]/g, " ").replace(/\\s+/g, " ").trim();',
  '\treturn out;',
  '}',
].join('\n');

const SANITIZER_TS = [
  '/** Чистка текста перед озвучкой: ролевые *действия*, тильды и markdown-маркеры не читаем. */',
  'function sanitizeForSpeech(text: string): string {',
  "  const raw = String(text ?? '');",
  '  let out = raw',
  "    .replace(/\\*[^*]*\\*/g, ' ')",
  "    .replace(/[*~`]/g, ' ')",
  "    .replace(/\\s+/g, ' ')",
  "    .replace(/\\s+([,.!?;:…])/g, '$1')",
  '    .trim();',
  "  if (out === '') out = raw.replace(/[*~`]/g, ' ').replace(/\\s+/g, ' ').trim();",
  '  return out;',
  '}',
].join('\n');

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, package: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`опция ${key} требует значение`);
      i += 1;
      return next;
    };
    if (key === '--dry-run') out.dryRun = true;
    else if (key === '--revert') out.revert = true;
    else if (key === '--package') out.package = value();
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`неизвестная опция: ${key}`);
  }
  return out;
}

function findPackage(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    return existsSync(join(path, 'package.json')) ? path : undefined;
  }
  const candidates = [];
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilesDir = join(dshHome, 'profiles');
  if (existsSync(profilesDir)) {
    for (const profile of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, profile, 'node_modules', 'dsh-pet'));
    }
  }
  candidates.push(join(process.cwd(), 'node_modules', 'dsh-pet'));
  return candidates.find((path) => existsSync(join(path, 'package.json')));
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function insertAfter(text, anchor, addition, label) {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`${label}: не найден якорь`);
  if (text.indexOf(anchor, at + 1) >= 0) throw new Error(`${label}: якорь встречается дважды`);
  return text.slice(0, at + anchor.length) + addition + text.slice(at + anchor.length);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node apply-speech-fixes.mjs [--dry-run] [--package <path>]\nnode apply-speech-fixes.mjs --revert');
    return;
  }

  const pkg = findPackage(args.package);
  if (!pkg) throw new Error('dsh-pet не найден; укажите --package <путь к node_modules/dsh-pet>');
  console.log(`dsh-pet: ${pkg}`);

  const backupRoot = join(pkg, BACKUP_DIR);
  if (args.revert) {
    if (!existsSync(backupRoot)) throw new Error(`бэкапов нет: ${backupRoot}`);
    // Идём от свежих бэкапов к старым: каждый файл восстанавливаем из самого нового прогона, где он есть.
    const dirs = readdirSync(backupRoot).sort().reverse();
    const restored = new Set();
    for (const name of dirs) {
      const dir = join(backupRoot, name);
      for (const file of readdirSync(dir)) {
        if (restored.has(file)) continue;
        const target = join(pkg, file.split('__').join(sep));
        if (!existsSync(target)) continue;
        writeFileSync(target, readFileSync(join(dir, file)));
        restored.add(file);
        console.log(`восстановлен: ${target}`);
      }
    }
    console.log('\nГотово. Перезапустите DSH (или сохраните настройки питомца — helper перезапустится).');
    return;
  }

  const files = {
    core: join(pkg, 'runtime', 'electron-helper', 'shared-core.js'),
    client: join(pkg, 'lib', 'client.js'),
    voice: join(pkg, 'src', 'shared', 'voice.ts'),
    events: join(pkg, 'runtime', 'electron-helper', 'events.js'),
  };
  for (const [key, file] of Object.entries(files)) {
    if (!existsSync(file)) throw new Error(`нет файла (${key}): ${file}`);
  }

  const plans = [];
  const addPlan = (file, text, label) => plans.push({ file, text, label });

  // 1) sanitizeForSpeech + вызов в speechSlice/playManual
  for (const [key, isTs] of [['core', false], ['client', false], ['voice', true]]) {
    const file = files[key];
    const text = readFileSync(file, 'utf8');
    if (text.includes('sanitizeForSpeech')) {
      console.log(`${relative(pkg, file)}: уже пропатчен`);
      continue;
    }
    const sanitizer = isTs ? SANITIZER_TS : SANITIZER_JS;
    const sliceAnchor = isTs
      ? 'export function speechSlice(text: string): string {\n  if (text.length <= VOICE_SPEECH_MAX_CHARS) return text;'
      : 'function speechSlice(text) {\n\tif (text.length <= VOICE_SPEECH_MAX_CHARS) return text;';
    const sliceReplace = isTs
      ? sanitizer + '\nexport function speechSlice(text: string): string {\n  text = sanitizeForSpeech(text);\n  if (text.length <= VOICE_SPEECH_MAX_CHARS) return text;'
      : sanitizer + '\nfunction speechSlice(text) {\n\ttext = sanitizeForSpeech(text);\n\tif (text.length <= VOICE_SPEECH_MAX_CHARS) return text;';
    const manualAnchor = isTs
      ? 'async function playManual(text: string, onPhase?: (phase: SpeakPhase) => void): Promise<void> {\n  const token = ++manualSeq;'
      : 'async function playManual(text, onPhase) {\n\tconst token = ++manualSeq;';
    const manualReplace = isTs
      ? 'async function playManual(text: string, onPhase?: (phase: SpeakPhase) => void): Promise<void> {\n  text = sanitizeForSpeech(text);\n  if (!text) return;\n  const token = ++manualSeq;'
      : 'async function playManual(text, onPhase) {\n\ttext = sanitizeForSpeech(text);\n\tif (!text) return;\n\tconst token = ++manualSeq;';

    let next = text;
    if (!next.includes(sliceAnchor)) throw new Error(`${relative(pkg, file)}: не найден speechSlice`);
    next = next.replace(sliceAnchor, sliceReplace);
    if (next.includes(manualAnchor)) next = next.replace(manualAnchor, manualReplace);
    addPlan(file, next, 'sanitizeForSpeech + чистка в speechSlice/playManual');
  }

  // 2) экспорт speakIfEnabled (shared-core.js)
  {
    const file = files.core;
    let text = plans.find((p) => p.file === file)?.text ?? readFileSync(file, 'utf8');
    if (!text.includes('exports.speakIfEnabled')) {
      text = insertAfter(text, 'exports.speakText = speakText\n', 'exports.speakIfEnabled = speakIfEnabled\n', 'shared-core.js (export)');
      const existing = plans.find((p) => p.file === file);
      if (existing) existing.text = text;
      else addPlan(file, text, 'экспорт speakIfEnabled');
    }
  }

  // 3) озвучка терминального статуса (events.js)
  {
    const file = files.events;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('S.speakIfEnabled')) {
      const anchor = '  this.workText = (snapshot && snapshot.task) || configuredText || null;\n  const terminal = state === \'success\' || state === \'error\';\n';
      if (!text.includes(anchor)) throw new Error('events.js: не найден якорь workText/terminal');
      const addition = '  // Озвучиваем финал задачи: терминальные статусы (успех/ошибка) проговариваем вслух.\n  if (stateChanged && terminal && configuredText && typeof S.speakIfEnabled === "function") {\n    S.speakIfEnabled(configuredText);\n  }\n';
      addPlan(file, text.replace(anchor, anchor + addition), 'озвучка финала задачи');
    } else {
      console.log('events.js: уже пропатчен');
    }
  }

  if (plans.length === 0) {
    console.log('\nМенять нечего.');
    return;
  }

  console.log('\nПлан:');
  for (const plan of plans) console.log(`  • ${relative(pkg, plan.file)}: ${plan.label}`);
  if (args.dryRun) {
    console.log('\n--dry-run: ничего не записано.');
    return;
  }

  const dir = join(backupRoot, stamp());
  mkdirSync(dir, { recursive: true });
  for (const plan of plans) {
    const name = relative(pkg, plan.file).split(sep).join('__');
    copyFileSync(plan.file, join(dir, name));
    writeFileSync(plan.file, plan.text, 'utf8');
    console.log(`записан: ${relative(pkg, plan.file)}`);
  }

  console.log('\nГотово. Перезапустите DSH или сохраните настройки питомца (helper перезапустится).');
}

try {
  main();
} catch (error) {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
