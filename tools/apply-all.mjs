#!/usr/bin/env node
/**
 * Установка всех правок dsh-pet одной командой.
 *
 * Прогоняет скрипты в правильном порядке (он важен: патчи `local-sapi*` и `local-piper`
 * сгенерированы от состояния «предыдущий уже применён»):
 *
 *   1. apply-ru-voices.mjs   — русские голоса Edge в белом списке
 *   2. apply-ru-menu.mjs     — локализация меню и подсказок
 *   3. apply-sapi-voice.mjs  — офлайн-резерв Windows SAPI
 *   4. apply-piper-voice.mjs — локальный нейроголос Piper (качает модель, ~60 МБ)
 *   5. apply-speech-fixes.mjs — чистка разметки + озвучка финала и ожидания подтверждения
 *
 * Скрипты идемпотентны: уже применённые правки пропускаются, поэтому повторный запуск
 * безопасен (это и есть штатный способ восстановить правки после обновления плагина).
 *
 * Использование:
 *   node tools/apply-all.mjs                # всё, включая Piper
 *   node tools/apply-all.mjs --skip-piper   # без скачивания модели
 *   node tools/apply-all.mjs --dry-run      # только план, ничего не пишем
 *   node tools/apply-all.mjs --revert       # откатить все правки (в обратном порядке)
 *   node tools/apply-all.mjs --package <путь к node_modules/dsh-pet>
 *
 * Флаги `--dry-run`, `--revert` и `--package` прокидываются в каждый скрипт, который их
 * понимает. `apply-ru-menu.mjs` пакет ищет сам (у него нет `--package`) — об этом
 * предупреждаем, чтобы не было сюрпризов при нестандартной установке.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Порядок применения. `optional` пропускается флагом; `package` — умеет ли скрипт `--package`. */
const STEPS = [
  { tool: 'apply-ru-voices.mjs', title: 'Русские голоса Edge', package: true, optional: null },
  { tool: 'apply-ru-menu.mjs', title: 'Локализация меню', package: false, optional: null },
  { tool: 'apply-sapi-voice.mjs', title: 'Офлайн-голос SAPI', package: true, optional: null },
  { tool: 'apply-piper-voice.mjs', title: 'Нейроголос Piper', package: true, optional: 'skip-piper' },
  { tool: 'apply-speech-fixes.mjs', title: 'Озвучка финала и подтверждения', package: true, optional: null },
];

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, package: '', skipPiper: false, help: false };
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
    else if (key === '--skip-piper') out.skipPiper = true;
    else if (key === '--package') out.package = value();
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`неизвестная опция: ${key}`);
  }
  return out;
}

/** Аргументы одного шага: только те флаги, которые этот скрипт действительно понимает. */
function argsFor(step, opts) {
  const args = [];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.revert) args.push('--revert');
  if (opts.package && step.package) args.push('--package', opts.package);
  return args;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        'node tools/apply-all.mjs [--dry-run] [--revert] [--skip-piper] [--package <путь>]',
        '',
        '  --dry-run      показать план каждого шага, ничего не записывая',
        '  --revert       откатить все правки (шаги в обратном порядке)',
        '  --skip-piper   не ставить локальный нейроголос (не качает модель)',
        '  --package      путь к node_modules/dsh-pet, если он не найден автоматически',
      ].join('\n'),
    );
    return;
  }

  const steps = opts.revert ? [...STEPS].reverse() : STEPS;
  const skipped = opts.skipPiper ? STEPS.find((s) => s.optional === 'skip-piper') : undefined;
  const planned = steps.filter((s) => !(opts.skipPiper && s.optional === 'skip-piper'));

  console.log(`dsh-pet: правок ${planned.length}${skipped ? ` (пропущен: ${skipped.title})` : ''}`);
  if (opts.package) {
    const noPackage = planned.filter((s) => !s.package);
    if (noPackage.length > 0) {
      console.log(
        `внимание: ${noPackage.map((s) => s.tool).join(', ')} не принимает --package и ищет плагин сам ` +
          '($DSH_HOME/profiles/*/node_modules/dsh-pet)',
      );
    }
  }
  if (opts.dryRun) console.log('режим --dry-run: ни один скрипт не будет писать файлы');
  if (opts.revert) console.log('режим --revert: откат в обратном порядке');

  const failed = [];
  for (const [index, step] of planned.entries()) {
    const script = join(HERE, step.tool);
    const label = `[${index + 1}/${planned.length}] ${step.title}`;
    if (!existsSync(script)) {
      failed.push({ step, reason: `нет файла ${script}` });
      console.error(`\n${label}: пропущен — нет файла ${step.tool}`);
      continue;
    }
    console.log(`\n=== ${label} — ${step.tool}`);
    const result = spawnSync(process.execPath, [script, ...argsFor(step, opts)], { stdio: 'inherit' });
    if (result.error) {
      failed.push({ step, reason: result.error.message });
      console.error(`${label}: ошибка запуска — ${result.error.message}`);
      break;
    }
    if (result.status !== 0) {
      failed.push({ step, reason: `код ${result.status}` });
      console.error(`${label}: шаг завершился с кодом ${result.status}`);
      break;
    }
  }

  console.log('');
  if (failed.length > 0) {
    const [first] = failed;
    console.error(`Остановлено на шаге «${first.step.title}»: ${first.reason}`);
    console.error('Исправьте причину и запустите снова — уже применённые шаги повторно не пишутся.');
    process.exitCode = 1;
    return;
  }
  if (opts.dryRun) {
    console.log('План показан. Ничего не изменено.');
    return;
  }
  console.log(
    opts.revert
      ? 'Готово: правки откачены. Перезапустите DSH (или сохраните настройки питомца — helper перезапустится).'
      : 'Готово. Перезапустите DSH (или сохраните настройки питомца — helper перезапустится), затем проверьте голос.',
  );
}

try {
  main();
} catch (error) {
  console.error('Ошибка: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
