#!/usr/bin/env node
/**
 * Добавляет русские голоса Edge в белый список dsh-pet.
 *
 * Плагин проверяет `voiceName` по массиву VOICES, в котором в 0.4.3 только китайские голоса.
 * Скрипт дописывает два русских голоса в собранный бандл (lib/index.js) и, если есть, в исходник
 * (src/host/voice/voices.ts), а затем при желании переключает voiceName в пользовательском конфиге.
 *
 * Идемпотентен: повторный запуск ничего не дублирует. Перед записью делает бэкап.
 *
 * Использование:
 *   node apply-ru-voices.mjs [--dry-run] [--package <path>] [--config <path>]
 *                            [--voice ru-RU-SvetlanaNeural|ru-RU-DmitryNeural] [--no-config]
 *   node apply-ru-voices.mjs --revert
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const RU_VOICES = [
  { id: 'ru-RU-SvetlanaNeural', name: 'Светлана', tag: 'жен · русский' },
  { id: 'ru-RU-DmitryNeural', name: 'Дмитрий', tag: 'муж · русский' },
];
const BUNDLE_MARKER = 'const VOICES = [';
const SOURCE_MARKER = 'export const VOICES: readonly VoiceInfo[] = [';
const BACKUP_DIR = '.ru-voices-backup';

/** Разбор argv: только длинные опции, значения через пробел или `=`. */
function parseArgs(argv) {
  const out = { dryRun: false, revert: false, noConfig: false, voice: RU_VOICES[0].id, package: '', config: '' };
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
    else if (key === '--no-config') out.noConfig = true;
    else if (key === '--package') out.package = value();
    else if (key === '--config') out.config = value();
    else if (key === '--voice') out.voice = value();
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`неизвестная опция: ${key}`);
  }
  if (!RU_VOICES.some((voice) => voice.id === out.voice)) {
    throw new Error(`--voice: допустимо ${RU_VOICES.map((voice) => voice.id).join(' или ')}`);
  }
  return out;
}

/** Ищем установленный пакет: явный путь, затем профили DSH, затем текущая папка. */
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

/** JSON без BOM. */
function readJson(text, label) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label}: не парсится как JSON (${error.message})`);
  }
}

/**
 * Вставка перед закрытием массива.
 * @returns новый текст или null, если все голоса уже на месте.
 */
function insertVoices(text, marker, buildEntry) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`не найден маркер "${marker}" — версия плагина не поддерживается`);
  const end = text.indexOf('\n];', start);
  if (end < 0) throw new Error('не найден конец массива VOICES — версия плагина не поддерживается');
  const block = text.slice(start, end);
  const missing = RU_VOICES.filter((voice) => !block.includes(voice.id));
  if (missing.length === 0) return null;
  return text.slice(0, end) + missing.map(buildEntry).join('') + text.slice(end);
}

/** Метка времени для папки бэкапа. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Запись с бэкапом в `<package>/.ru-voices-backup/<runStamp>/<relative path>`; возвращает путь бэкапа. */
function writeWithBackup(pkgRoot, file, content, runStamp) {
  const backupDir = join(pkgRoot, BACKUP_DIR, runStamp);
  const rel = relative(pkgRoot, file).split(sep).join('__');
  mkdirSync(backupDir, { recursive: true });
  const dst = join(backupDir, rel);
  copyFileSync(file, dst);
  writeFileSync(file, content, 'utf8');
  return dst;
}

/** Откат последней установки. */
function revert(pkg) {
  const root = join(pkg, BACKUP_DIR);
  if (!existsSync(root)) throw new Error(`бэкапов нет: ${root}`);
  const dirs = readdirSync(root).sort();
  if (dirs.length === 0) throw new Error(`бэкапов нет: ${root}`);
  const dir = join(root, dirs[dirs.length - 1]);
  for (const name of readdirSync(dir)) {
    const rel = name.split('__').join(sep);
    const target = join(pkg, rel);
    if (!existsSync(target)) {
      console.log(`пропущен (нет файла): ${target}`);
      continue;
    }
    writeFileSync(target, readFileSync(join(dir, name)));
    console.log(`восстановлен: ${target}`);
  }
  console.log('\nГотово. Полностью перезапустите DSH.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node apply-ru-voices.mjs [--dry-run] [--revert] [--package <path>] [--config <path>]\n' +
      '                            [--voice ru-RU-SvetlanaNeural|ru-RU-DmitryNeural] [--no-config]');
    return;
  }

  const pkg = findPackage(args.package);
  if (!pkg) throw new Error('dsh-pet не найден; укажите --package <путь к node_modules/dsh-pet>');
  const version = readJson(readFileSync(join(pkg, 'package.json'), 'utf8'), 'package.json').version;
  console.log(`dsh-pet ${version}: ${pkg}`);

  if (args.revert) {
    revert(pkg);
    return;
  }

  const bundlePath = join(pkg, 'lib', 'index.js');
  if (!existsSync(bundlePath)) throw new Error(`нет файла ${bundlePath}`);
  const patchedBundle = insertVoices(readFileSync(bundlePath, 'utf8'), BUNDLE_MARKER, (voice) =>
    `,\n\t{\n\t\tid: "${voice.id}",\n\t\tname: "${voice.name}",\n\t\ttag: "${voice.tag}",\n\t\tdefault: false\n\t}`,
  );

  const sourcePath = join(pkg, 'src', 'host', 'voice', 'voices.ts');
  const patchedSource = existsSync(sourcePath)
    ? insertVoices(readFileSync(sourcePath, 'utf8'), SOURCE_MARKER, (voice) =>
        `\n  { id: '${voice.id}', name: '${voice.name}', tag: '${voice.tag}', default: false },`,
      )
    : undefined;

  const configPath = args.config
    ? resolve(args.config)
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-pet', 'main-config.jsonc');
  const config = !args.noConfig && existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  let patchedConfig;
  if (config !== undefined) {
    readJson(config, configPath);
    const re = /"voiceName":\s*"[^"]*"/;
    if (!re.test(config)) throw new Error(`${configPath}: не найдено поле voiceName`);
    patchedConfig = config.replace(re, `"voiceName": "${args.voice}"`);
  }

  const changes = [];
  if (patchedBundle !== null) changes.push(`lib/index.js: + ${RU_VOICES.map((voice) => voice.id).join(', ')}`);
  if (patchedSource) changes.push('src/host/voice/voices.ts: то же в исходниках');
  if (patchedConfig !== undefined && patchedConfig !== config) changes.push(`${configPath}: voiceName → ${args.voice}`);

  if (changes.length === 0) {
    console.log('\nУже пропатчено, менять нечего.');
    return;
  }
  console.log('\nПлан:');
  for (const line of changes) console.log('  • ' + line);
  if (args.dryRun) {
    console.log('\n--dry-run: ничего не записано.');
    return;
  }

  // Одна метка на запуск: все файлы одного прогона лежат в одной папке бэкапа, --revert откатывает их вместе.
  const runStamp = stamp();
  if (patchedBundle !== null) console.log('бэкап:', writeWithBackup(pkg, bundlePath, patchedBundle, runStamp));
  if (patchedSource) console.log('бэкап:', writeWithBackup(pkg, sourcePath, patchedSource, runStamp));
  if (patchedConfig !== undefined && patchedConfig !== config) {
    writeFileSync(configPath, patchedConfig, 'utf8');
    console.log('конфиг обновлён:', configPath);
  }

  console.log('\nГотово. Полностью перезапустите DSH, иначе старый модуль останется в памяти.');
}

try {
  main();
} catch (error) {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
