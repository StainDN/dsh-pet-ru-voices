#!/usr/bin/env node
/**
 * Русская локализация меню и подсказок dsh-pet в desktop-helper.
 *
 * Плагин рисует правый клик по питомцу и подсказки горячих клавиш китайскими литералами прямо в
 * runtime/electron-helper. Скрипт заменяет их на русские в трёх файлах и правит одну строку кода
 * (подписи клавиш 1–4). TODO-комментарии и код не трогаются — только строковые литералы.
 *
 * Идемпотентен: повторный запуск ничего не меняет. Перед записью делает бэкап.
 *
 * Использование:
 *   node apply-ru-menu.mjs [--dry-run] [--helper <path>]
 *   node apply-ru-menu.mjs --revert
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

/** Китайский литерал → русский. Заменяются только строки в кавычках. */
const MAP = {
  '打开软件': 'Открыть Harness',
  '打开 AI 设置': 'Открыть настройки ИИ',
  '打开网站': 'Открыть сайт',
  '查看余额': 'Показать баланс',
  '待办事项': 'Задачи',
  '碎碎念': 'Болтовня',
  '对话': 'Поговорить',
  '配图': 'Картинки',
  '纳入对话的配图': 'Картинки для диалога',
  '睡觉': 'Спать',
  '起来': 'Проснуться',
  '动作': 'Действия',
  '显示位置': 'Где показывать',
  '仅网页': 'Только в окне',
  '仅桌面': 'Только на столе',
  '两者': 'И там и там',
  '都不': 'Не показывать',
  '重载配置': 'Перезагрузить настройки',
  '回到初始位置': 'Вернуть на место',
  '更多': 'Ещё',
  'L 键': 'клавиша L',
  'S 键': 'клавиша S',
  'Z 键': 'клавиша Z',
  'D 键': 'клавиша D',
  '1 键': 'клавиша 1',
  '2 键': 'клавиша 2',
  '3 键': 'клавиша 3',
  '4 键': 'клавиша 4',
  '待机': 'Ожидание',
  '转向': 'Поворот',
  '拖拽': 'Перетаскивание',
  '点击回应': 'Реакция на клик',
  '移动': 'Перемещение',
  '余额档位': 'Баланс (уровни)',
  '工作状态': 'Рабочие статусы',
  'Ctrl+左键': 'Ctrl + ЛКМ',
  'Cmd+左键': 'Cmd + ЛКМ',
};

/** Точечные правки кода (не литералов). */
const CODE_FIXES = [
  [
    'const DISPLAY_HOTKEY_HINTS = DISPLAY_ORDER.map((_, index) => String(index + 1) + " 键");',
    'const DISPLAY_HOTKEY_HINTS = DISPLAY_ORDER.map((_, index) => "клавиша " + String(index + 1));',
  ],
];

/** Файлы helper'а, которые переводятся (пути относительно runtime/electron-helper). */
const FILES = ['sprite/menu.js', 'shared-core.js', 'sprite.js'];

const BACKUP_DIR = '.ru-menu-backup';

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, helper: '' };
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
    else if (key === '--helper') out.helper = value();
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`неизвестная опция: ${key}`);
  }
  return out;
}

/** Ищем helper: явный путь, затем профили DSH, затем текущая папка. */
function findHelper(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    return existsSync(join(path, 'shared-core.js')) ? path : undefined;
  }
  const candidates = [];
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilesDir = join(dshHome, 'profiles');
  if (existsSync(profilesDir)) {
    for (const profile of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, profile, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper'));
    }
  }
  candidates.push(join(process.cwd(), 'node_modules', 'dsh-pet', 'runtime', 'electron-helper'));
  return candidates.find((path) => existsSync(join(path, 'shared-core.js')));
}

/** Метка времени для папки бэкапа. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Замены в одном файле; возвращает новый текст и число заменённых ключей. */
function translate(text) {
  let out = text;
  let changed = 0;
  for (const [from, to] of CODE_FIXES) {
    if (out.includes(from)) {
      out = out.split(from).join(to);
      changed += 1;
    }
  }
  for (const [zh, ru] of Object.entries(MAP)) {
    const escaped = zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(["'])${escaped}\\1`, 'g');
    const before = out;
    out = out.replace(re, (match, quote) => quote + ru + quote);
    if (out !== before) changed += 1;
  }
  return { out, changed };
}

/** Уже переведён ли файл (есть ли хотя бы один русский литерал из словаря). */
function looksTranslated(text) {
  return Object.values(MAP).some((ru) => text.includes(`"${ru}"`) || text.includes(`'${ru}'`));
}

function revert(helper) {
  const root = join(helper, BACKUP_DIR);
  if (!existsSync(root)) throw new Error(`бэкапов нет: ${root}`);
  const dirs = readdirSync(root).sort();
  if (dirs.length === 0) throw new Error(`бэкапов нет: ${root}`);
  const dir = join(root, dirs[dirs.length - 1]);
  for (const name of readdirSync(dir)) {
    const rel = name.split('__').join(sep);
    const target = join(helper, rel);
    if (!existsSync(target)) {
      console.log(`пропущен (нет файла): ${target}`);
      continue;
    }
    writeFileSync(target, readFileSync(join(dir, name)));
    console.log(`восстановлен: ${target}`);
  }
  console.log('\nГотово. Меню обновится после перезапуска helper (см. README).');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node apply-ru-menu.mjs [--dry-run] [--helper <path>]\n' +
      'node apply-ru-menu.mjs --revert');
    return;
  }

  const helper = findHelper(args.helper);
  if (!helper) throw new Error('electron-helper не найден; укажите --helper <путь к runtime/electron-helper>');
  console.log(`helper: ${helper}`);

  if (args.revert) {
    revert(helper);
    return;
  }

  const plans = [];
  for (const rel of FILES) {
    const file = join(helper, rel.split('/').join(sep));
    if (!existsSync(file)) {
      console.log(`пропущен (нет файла): ${rel}`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const { out, changed } = translate(text);
    if (changed === 0) {
      console.log(`${rel}: уже переведено, менять нечего`);
      continue;
    }
    if (!looksTranslated(text) && out === text) {
      console.log(`${rel}: не найдено ни одного китайского литерала — версия helper'а не совпадает`);
      continue;
    }
    plans.push({ rel, file, text, out, changed });
  }

  if (plans.length === 0) {
    console.log('\nМенять нечего.');
    return;
  }

  console.log('\nПлан:');
  for (const plan of plans) console.log(`  • ${plan.rel}: заменено ключей ${plan.changed}`);
  if (args.dryRun) {
    console.log('\n--dry-run: ничего не записано.');
    return;
  }

  const backupDir = join(helper, BACKUP_DIR, stamp());
  mkdirSync(backupDir, { recursive: true });
  for (const plan of plans) {
    const backupName = relative(helper, plan.file).split(sep).join('__');
    copyFileSync(plan.file, join(backupDir, backupName));
    writeFileSync(plan.file, plan.out, 'utf8');
    console.log(`записан: ${plan.rel} (бэкап ${backupName})`);
  }

  console.log('\nГотово. Меню обновится после перезапуска helper:');
  console.log('  либо перезапустите DSH, либо нажмите «Сохранить» в настройках питомца —');
  console.log('  сохранение конфига перезапускает desktop-helper.');
}

try {
  main();
} catch (error) {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
