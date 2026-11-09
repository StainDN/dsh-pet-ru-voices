#!/usr/bin/env node
/**
 * Локальный нейроголос Piper для dsh-pet.
 *
 * Ставит полностью офлайн-синтез:
 *   • venv с piper-tts (pip install piper-tts) и модель ru_RU-*-medium с HuggingFace;
 *   • piper_serve.py — постоянный процесс: модель грузится один раз, фраза ~0.1 с;
 *   • в lib/index.js — порядок каналов Piper → SAPI → Edge.
 *
 * Идемпотентно, с бэкапом. Нужен Python 3.9+ в PATH и интернет только на этапе установки.
 *
 * Использование:
 *   node apply-piper-voice.mjs [--dry-run] [--skip-setup] [--voice irina|dmitri]
 *                              [--package <path>] [--user-data <path>]
 *   node apply-piper-voice.mjs --revert
 */
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_SERVER = join(HERE, '..', 'assets', 'piper_serve.py');
const BACKUP_DIR = '.piper-backup';
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU';

const HELPERS = `
/** Локальный нейроголос Piper: постоянный процесс, модель грузится один раз (~5 с), фраза ~0.1-0.2 с. */
const PIPER_BOOT_TIMEOUT_MS = 40e3;
const PIPER_TIMEOUT_MS = 15e3;
const PIPER_COOLDOWN_MS = 6e5;
let piperChild = null;
let piperSeq = 0;
let piperDownUntil = 0;
const piperPending = new Map();
function piperPaths(voice) {
	const root = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-pet", "piper");
	const python = process.env.DSH_PET_PIPER_PYTHON || join(root, "venv", "Scripts", "python.exe");
	const script = process.env.DSH_PET_PIPER_SERVER || join(root, "piper_serve.py");
	const female = join(root, "voices", "ru_RU-irina-medium.onnx");
	const male = join(root, "voices", "ru_RU-dmitri-medium.onnx");
	const wantsMale = /dmitry|dmitri/i.test(String(voice || ""));
	const model = wantsMale && existsSync(male) ? male : female;
	return { python, script, model, modelDir: join(root, "voices") };
}
function ensurePiper(voice) {
	if (piperChild) return piperChild;
	const { python, script, model } = piperPaths(voice);
	if (!existsSync(python) || !existsSync(script) || !existsSync(model)) return null;
	const child = spawn(python, [script, "--model", model], {
		windowsHide: true,
		env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" }
	});
	piperChild = child;
	let buffer = "";
	const fail = (error) => {
		if (piperChild === child) piperChild = null;
		for (const pending of piperPending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		piperPending.clear();
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\\n");
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const pending = piperPending.get(message.id);
			if (!pending) continue;
			piperPending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.ok) pending.resolve();
			else pending.reject(new Error("piper: " + String(message.error || "failed")));
		}
	});
	child.on("error", fail);
	child.on("exit", () => fail(new Error("piper: exited")));
	child.stdin.on("error", () => {});
	return child;
}
async function synthesizePiper({ text, voice, target }) {
	const child = ensurePiper(voice);
	if (!child) throw new Error("piper: not installed");
	const staging = target + ".part";
	const id = ++piperSeq;
	const timeout = id === 1 ? PIPER_BOOT_TIMEOUT_MS : PIPER_TIMEOUT_MS;
	await new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			piperPending.delete(id);
			rejectPromise(new Error("piper: timeout"));
		}, timeout);
		piperPending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
		child.stdin.write(JSON.stringify({ id, text, out: staging }) + "\\n");
	});
	const info = await stat(staging);
	if (!info.size) throw new Error("piper: empty audio");
	await rename(staging, target);
}
async function synthesizePiperSafe(input) {
	if (Date.now() < piperDownUntil) return false;
	try {
		await synthesizePiper(input);
		return true;
	} catch {
		piperDownUntil = Date.now() + PIPER_COOLDOWN_MS;
		return false;
	}
}
`;

const HEAD_FROM = `async function synthesize({ signal, text, voice, rate, target }) {
	if (Date.now() < edgeDownUntil) {`;
const HEAD_TO = `async function synthesize({ signal, text, voice, rate, target }) {
	if (await synthesizePiperSafe({ text, voice, target })) return;
	if (Date.now() < edgeDownUntil) {`;

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, skipSetup: false, voice: 'irina', package: '', userData: '' };
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
    else if (key === '--skip-setup') out.skipSetup = true;
    else if (key === '--voice') out.voice = value();
    else if (key === '--package') out.package = value();
    else if (key === '--user-data') out.userData = value();
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`неизвестная опция: ${key}`);
  }
  if (!['irina', 'dmitri'].includes(out.voice)) throw new Error('--voice: irina или dmitri');
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

function replaceOnce(text, from, to, label) {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`${label}: не найден фрагмент для замены`);
  if (text.indexOf(from, at + 1) >= 0) throw new Error(`${label}: фрагмент встречается больше одного раза`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`пустой ответ: ${url}`);
  writeFileSync(dest, buffer);
  return buffer.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node apply-piper-voice.mjs [--dry-run] [--skip-setup] [--voice irina|dmitri]\n' +
      '                             [--package <path>] [--user-data <path>]\n' +
      'node apply-piper-voice.mjs --revert');
    return;
  }

  const pkg = findPackage(args.package);
  if (!pkg) throw new Error('dsh-pet не найден; укажите --package <путь к node_modules/dsh-pet>');
  const userData = args.userData ? resolve(args.userData) : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-pet');
  const piperRoot = join(userData, 'piper');
  const venv = join(piperRoot, 'venv');
  const pythonExe = join(venv, 'Scripts', 'python.exe');
  const pipExe = join(venv, 'Scripts', 'pip.exe');
  const serverPath = join(piperRoot, 'piper_serve.py');
  const modelName = `ru_RU-${args.voice}-medium`;
  const modelPath = join(piperRoot, 'voices', `${modelName}.onnx`);

  console.log(`dsh-pet: ${pkg}`);
  console.log(`piper:   ${piperRoot}`);

  const backupRoot = join(pkg, BACKUP_DIR);
  if (args.revert) {
    if (!existsSync(backupRoot)) throw new Error(`бэкапов нет: ${backupRoot}`);
    const dirs = readdirSync(backupRoot).sort();
    const dir = join(backupRoot, dirs[dirs.length - 1]);
    for (const name of readdirSync(dir)) {
      const target = join(pkg, name.split('__').join(sep));
      if (!existsSync(target)) continue;
      writeFileSync(target, readFileSync(join(dir, name)));
      console.log(`восстановлен: ${target}`);
    }
    console.log('\nГотово. Перезапустите DSH.');
    return;
  }

  const libPath = join(pkg, 'lib', 'index.js');
  const lib = readFileSync(libPath, 'utf8');
  const needsPatch = !lib.includes('synthesizePiperSafe');
  const needsServer = !existsSync(serverPath) || readFileSync(serverPath, 'utf8') !== readFileSync(ASSET_SERVER, 'utf8');
  const needsVenv = !existsSync(pythonExe);
  const needsModel = !existsSync(modelPath);

  console.log('\nПлан:');
  console.log(needsPatch ? '  • lib/index.js: Piper как основной канал (Piper → SAPI → Edge)' : '  • lib/index.js: уже пропатчен');
  console.log(needsServer ? `  • ${serverPath}: установить сервер синтеза` : '  • сервер синтеза: уже на месте');
  console.log(needsVenv ? `  • venv + pip install piper-tts: ${venv}` : '  • venv: уже есть');
  console.log(needsModel ? `  • модель ${modelName}.onnx (~63 МБ) с HuggingFace` : `  • модель ${modelName}: уже есть`);

  if (args.dryRun) {
    console.log('\n--dry-run: ничего не записано.');
    return;
  }

  // 1) Скрипт сервера
  if (needsServer) {
    mkdirSync(piperRoot, { recursive: true });
    copyFileSync(ASSET_SERVER, serverPath);
    console.log(`установлен сервер: ${serverPath}`);
  }

  // 2) venv и зависимость
  if (needsVenv) {
    if (args.skipSetup) throw new Error('venv нет, а --skip-setup указан');
    const python = process.env.DSH_PET_PYTHON || 'python';
    console.log('создаю venv…');
    const created = spawnSync(python, ['-m', 'venv', venv], { stdio: 'inherit' });
    if (created.status !== 0) throw new Error('не удалось создать venv (нужен Python 3.9+ в PATH)');
    console.log('ставлю piper-tts (это ~1 минута)…');
    const installed = spawnSync(pipExe, ['install', '--disable-pip-version-check', '--no-input', 'piper-tts'], { stdio: 'inherit' });
    if (installed.status !== 0) throw new Error('pip install piper-tts завершился ошибкой');
  }

  // 3) Модель
  if (needsModel) {
    if (args.skipSetup) throw new Error('модели нет, а --skip-setup указан');
    mkdirSync(join(piperRoot, 'voices'), { recursive: true });
    for (const suffix of ['.onnx', '.onnx.json']) {
      const url = `${HF}/${args.voice}/medium/${modelName}.onnx${suffix === '.onnx' ? '' : '.json'}`;
      const dest = `${modelPath}${suffix === '.onnx' ? '' : '.json'}`;
      process.stdout.write(`скачиваю ${suffix}… `);
      const size = await download(url, dest);
      console.log(`${(size / 1024 / 1024).toFixed(1)} МБ`);
    }
  }

  // 4) Патч бандла
  if (needsPatch) {
    const dir = join(backupRoot, stamp());
    mkdirSync(dir, { recursive: true });
    copyFileSync(libPath, join(dir, 'lib__index.js'));
    const next = replaceOnce(lib, HEAD_FROM, HELPERS + '\n' + HEAD_TO, 'lib/index.js (piper-first)');
    writeFileSync(libPath, next, 'utf8');
    console.log('пропатчен: lib/index.js');
  }

  console.log('\nГотово. Полностью перезапустите DSH:');
  console.log('  первая фраза ~5-6 с (загрузка модели), дальше ~0.1-0.2 с.');
}

main().catch((error) => {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
