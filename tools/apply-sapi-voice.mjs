#!/usr/bin/env node
/**
 * Локальный голос для dsh-pet: резервный синтез через Windows SAPI.
 *
 * Edge TTS требует интернет и без VPN молчит. Скрипт ставит локальный резерв:
 *   • кладёт tts.ps1 в <userData>/sapi/tts.ps1 (синтез SAPI: голоса, установленные в Windows);
 *   • в lib/index.js добавляет synthesizeSapi и ветку «Edge не ответил за 4 с → локальный голос»;
 *   • учит /voice/speak отдавать правильный Content-Type (WAV от SAPI, MP3 от Edge).
 *
 * Идемпотентно, с бэкапом. После установки нужен перезапуск DSH.
 *
 * Использование:
 *   node apply-sapi-voice.mjs [--dry-run] [--package <path>] [--user-data <path>]
 *   node apply-sapi-voice.mjs --revert
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET = join(HERE, '..', 'assets', 'sapi-tts.ps1');
const BACKUP_DIR = '.sapi-backup';

const JS_HELPERS = `
/** Локальный резерв синтеза: Windows SAPI (голоса системы, интернет не нужен). */
const SAPI_TIMEOUT_MS = 15e3;
const EDGE_TIMEOUT_MS = 4e3;
const EDGE_COOLDOWN_MS = 6e5;
let edgeDownUntil = 0;
function sapiScriptPath() {
	const candidates = [];
	if (process.env.DSH_PET_SAPI_SCRIPT) candidates.push(process.env.DSH_PET_SAPI_SCRIPT);
	if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, "dsh-pet", "sapi", "tts.ps1"));
	candidates.push(join(homedir(), ".dsh", "dsh-pet", "sapi", "tts.ps1"));
	return candidates.find((file) => existsSync(file));
}
async function synthesizeSapi({ text, target }) {
	const script = sapiScriptPath();
	if (!script) throw new Error("sapi: script not found");
	const textFile = target + ".txt";
	const staging = target + ".part";
	await writeFile(textFile, text, "utf8");
	try {
		await new Promise((resolvePromise, rejectPromise) => {
			const child = spawn("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-STA",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script,
				"-TextFile",
				textFile,
				"-OutFile",
				staging
			], { windowsHide: true });
			const timer = setTimeout(() => {
				child.kill();
				rejectPromise(new Error("sapi: timeout"));
			}, SAPI_TIMEOUT_MS);
			child.on("error", (error) => {
				clearTimeout(timer);
				rejectPromise(error);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolvePromise();
				else rejectPromise(new Error("sapi: exit " + code));
			});
		});
		const info = await stat(staging);
		if (!info.size) throw new Error("sapi: empty audio");
		await rename(staging, target);
	} finally {
		await rm(textFile, { force: true }).catch(() => void 0);
		await rm(staging, { force: true }).catch(() => void 0);
	}
}
`;

const JS_BRANCH = `async function synthesize({ signal, text, voice, rate, target }) {
	if (Date.now() < edgeDownUntil) {
		try {
			await synthesizeSapi({ text, target });
			return;
		} catch {}
	}`;

const JS_CATCH = `	} catch (error) {
		await rm(staging, { force: true }).catch(() => void 0);
		edgeDownUntil = Date.now() + EDGE_COOLDOWN_MS;
		// Edge недоступен (нет интернета / 429) — говорим локальным голосом.
		try {
			await synthesizeSapi({ text, target });
			return;
		} catch (sapiError) {
			const primary = error instanceof Error ? error.message : String(error);
			const local = sapiError instanceof Error ? sapiError.message : String(sapiError);
			throw new VoiceSynthError(primary + "; sapi: " + local);
		}
	}`;

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, package: '', userData: '' };
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
    else if (key === '--user-data') out.userData = value();
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

function replaceOnce(text, from, to, label) {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`${label}: не найден фрагмент для замены`);
  if (text.indexOf(from, at + 1) >= 0) throw new Error(`${label}: фрагмент встречается больше одного раза`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node apply-sapi-voice.mjs [--dry-run] [--package <path>] [--user-data <path>]\n' +
      'node apply-sapi-voice.mjs --revert');
    return;
  }

  const pkg = findPackage(args.package);
  if (!pkg) throw new Error('dsh-pet не найден; укажите --package <путь к node_modules/dsh-pet>');
  const userData = args.userData
    ? resolve(args.userData)
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-pet');
  console.log(`dsh-pet: ${pkg}`);
  console.log(`user data: ${userData}`);

  const backupRoot = join(pkg, BACKUP_DIR);
  if (args.revert) {
    if (!existsSync(backupRoot)) throw new Error(`бэкапов нет: ${backupRoot}`);
    const dirs = readdirSync(backupRoot).sort();
    const dir = join(backupRoot, dirs[dirs.length - 1]);
    for (const name of readdirSync(dir)) {
      const target = join(pkg, name.split('__').join(sep));
      if (!existsSync(target)) {
        console.log(`пропущен (нет файла): ${target}`);
        continue;
      }
      writeFileSync(target, readFileSync(join(dir, name)));
      console.log(`восстановлен: ${target}`);
    }
    console.log('\nГотово. Перезапустите DSH.');
    return;
  }

  const libPath = join(pkg, 'lib', 'index.js');
  if (!existsSync(libPath)) throw new Error(`нет файла ${libPath}`);
  let lib = readFileSync(libPath, 'utf8');
  const libPatched = lib.includes('synthesizeSapi');

  const edgePath = join(pkg, 'src', 'host', 'voice', 'edge.ts');
  const routePath = join(pkg, 'src', 'host', 'routes', 'voice.ts');
  const edge = existsSync(edgePath) ? readFileSync(edgePath, 'utf8') : undefined;
  const route = existsSync(routePath) ? readFileSync(routePath, 'utf8') : undefined;

  const plans = [];
  if (!libPatched) {
    let next = replaceOnce(lib, 'async function synthesize({ signal, text, voice, rate, target }) {', JS_HELPERS + '\n' + JS_BRANCH, 'lib/index.js (helper + ветка)');
    next = replaceOnce(next, '\t\t\tsignal,\n\t\t\ttimeout: SYNTHESIS_TIMEOUT_MS', '\t\t\tsignal: AbortSignal.timeout(EDGE_TIMEOUT_MS),\n\t\t\ttimeout: EDGE_TIMEOUT_MS', 'lib/index.js (таймаут)');
    next = replaceOnce(next, '\t} catch (error) {\n\t\tawait rm(staging, { force: true }).catch(() => void 0);\n\t\tthrow new VoiceSynthError(error instanceof Error ? error.message : String(error));\n\t}', JS_CATCH, 'lib/index.js (catch)');
    next = replaceOnce(next, '\t\treturn {\n\t\t\tkind: "file",\n\t\t\tfile: result.file,\n\t\t\tcontentType: "audio/mpeg"\n\t\t};', '\t\tlet contentType = "audio/mpeg";\n\t\ttry {\n\t\t\tconst head = readFileSync(result.file);\n\t\t\tif (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE") contentType = "audio/wav";\n\t\t} catch {}\n\t\treturn {\n\t\t\tkind: "file",\n\t\t\tfile: result.file,\n\t\t\tcontentType\n\t\t};', 'lib/index.js (content-type)');
    plans.push({ path: libPath, text: next, label: 'lib/index.js' });
  }

  const scriptPath = join(userData, 'sapi', 'tts.ps1');
  const scriptChanged = !existsSync(scriptPath) || readFileSync(scriptPath, 'utf8') !== readFileSync(ASSET, 'utf8');

  console.log('\nПлан:');
  if (plans.length > 0) console.log('  • lib/index.js: synthesizeSapi + локальный резерв + Content-Type');
  else console.log('  • lib/index.js: уже пропатчен');
  if (scriptChanged) console.log(`  • ${scriptPath}: установить/обновить скрипт синтеза`);
  if (args.dryRun) {
    console.log('\n--dry-run: ничего не записано.');
    return;
  }

  const runStamp = stamp();
  for (const plan of plans) {
    const dir = join(backupRoot, runStamp);
    mkdirSync(dir, { recursive: true });
    const name = relative(pkg, plan.path).split(sep).join('__');
    copyFileSync(plan.path, join(dir, name));
    writeFileSync(plan.path, plan.text, 'utf8');
    console.log(`записан: ${plan.label} (бэкап ${name})`);
  }

  if (scriptChanged) {
    mkdirSync(dirname(scriptPath), { recursive: true });
    copyFileSync(ASSET, scriptPath);
    console.log(`установлен: ${scriptPath} (${statSync(scriptPath).size} байт)`);
  }

  console.log('\nГотово. Полностью перезапустите DSH:');
  console.log('  после перезапуска Edge пробуется 4 с, затем — локальный голос Windows;');
  console.log('  после первой неудачи Edge 10 минут не трогаем, говорим сразу локально.');
}

try {
  main();
} catch (error) {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
