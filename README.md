# dsh-pet: русские голоса, локализация и офлайн-голос

Четыре независимых патча к [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) **0.4.3**:

1. **Русские голоса Edge** — чтобы питомец мог говорить по-русски, а не только по-китайски.
2. **Русская локализация меню** — правый клик по питомцу и подписи горячих клавиш в desktop-helper.
3. **Локальный голос (Windows SAPI)** — офлайн-резерв на случай, когда Edge недоступен (нет VPN, 429, нет сети).
4. **Локальный нейроголос Piper** — тот же офлайн, но нормальным голосом; ставится поверх SAPI-резерва.

Каждый патч ставится своим скриптом (с бэкапом и откатом) либо обычным diff-файлом.

---

## 1. Русские голоса Edge

### Проблема

В 0.4.3 в массиве `VOICES` только четыре китайских голоса (`zh-CN-*`). Если текст питомца русский,
Edge TTS получает китайский голос и русский текст и возвращает пустой ответ. В логе
`~/.dsh/dsh-pet/logs.txt` это выглядит так:

```
[warn] voice speak: failed chars=55 voice=edge ms=708
       reason=The service returned no audio. Voices are locale specific, ...
```

Сообщение сбивает с толку: та же ошибка приходит и когда сервис просто отдаёт `429`.
Итог один — питомец молчит, хотя `voiceEnabled`, громкость и шёпот включены.

### Что меняется

| Файл | Изменение |
|---|---|
| `lib/index.js` | в `VOICES` добавляются `ru-RU-SvetlanaNeural` («Светлана», женский) и `ru-RU-DmitryNeural` («Дмитрий», мужской) |
| `src/host/voice/voices.ts` | то же в исходниках — если собираете плагин из source |
| `~/.dsh/dsh-pet/main-config.jsonc` | опционально: `voiceName` переключается на выбранный русский голос |

### Установка

```powershell
node tools/apply-ru-voices.mjs --dry-run          # посмотреть план
node tools/apply-ru-voices.mjs                    # применить (женский голос)
node tools/apply-ru-voices.mjs --voice ru-RU-DmitryNeural   # мужской голос
```

| Опция | Значение |
|---|---|
| `--package <path>` | путь к установленному `dsh-pet`; по умолчанию ищется в `%USERPROFILE%\.dsh\profiles\*\node_modules\dsh-pet` и рядом с текущей папкой |
| `--config <path>` | путь к `main-config.jsonc`; по умолчанию `%USERPROFILE%\.dsh\dsh-pet\main-config.jsonc` |
| `--voice <id>` | `ru-RU-SvetlanaNeural` (по умолчанию) или `ru-RU-DmitryNeural` |
| `--no-config` | не трогать пользовательский конфиг |
| `--dry-run` | только показать план |
| `--revert` | откатить последнюю установку из бэкапа `<package>\.ru-voices-backup\...` |

**После установки полностью перезапустите DSH** — плагин загружается при старте, на лету правка
`lib/index.js` не подхватывается.

---

## 2. Русская локализация меню

### Проблема

Контекстное меню питомца и подписи горячих клавиш зашиты китайскими литералами в
`runtime/electron-helper`: `sprite/menu.js` (само меню), `shared-core.js` (пункты и подсказки),
`sprite.js` (подписи клавиш 1–4).

### Что меняется

| Файл | Что переводится |
|---|---|
| `runtime/electron-helper/sprite/menu.js` | пункты меню: «Поговорить», «Болтовня», «Задачи», «Спать», «Действия», «Где показывать», «Перезагрузить настройки» и т. д. |
| `runtime/electron-helper/shared-core.js` | те же подписи в общих структурах, группы «Баланс (уровни)», «Рабочие статусы», подсказки `Ctrl + ЛКМ` / `Cmd + ЛКМ` |
| `runtime/electron-helper/sprite.js` | подписи клавиш `клавиша 1…4` |

Меняются только строковые литералы (код и комментарии не трогаются). Полный словарь — в
`tools/apply-ru-menu.mjs` (константа `MAP`).

### Установка

```powershell
node tools/apply-ru-menu.mjs --dry-run   # план
node tools/apply-ru-menu.mjs             # применить
node tools/apply-ru-menu.mjs --revert    # откатить
```

`--helper <path>` — если helper лежит не в стандартном месте.

Меню обновится **без перезапуска DSH**: достаточно нажать «Сохранить» в настройках питомца —
сохранение конфига перезапускает desktop-helper.

---

## 3. Локальный голос (Windows SAPI)

### Проблема

Edge TTS живёт в интернете: без VPN в РФ он отвечает `429` или молчит — питомец замолкает, хотя
все настройки включены.

### Что делает патч

- ставит `~/.dsh/dsh-pet/sapi/tts.ps1` — синтез через SAPI (голоса, установленные в Windows;
  на русской Windows это «Microsoft Irina Desktop — Russian»);
- в `lib/index.js` добавляет `synthesizeSapi()` и логику выбора канала:
  - Edge пробуется с таймаутом **4 с**;
  - если не ответил — сразу локальный голос, а Edge не трогаем **10 минут** (чтобы не ждать таймаут каждую фразу);
  - при следующей попытке (через 10 минут) снова сначала Edge — если VPN включён, вернётся нейроголос;
- учит `/voice/speak` отдавать правильный `Content-Type`: WAV от SAPI, MP3 от Edge (по сигнатуре файла).

Кэш общий: уже озвученные фразы проигрываются мгновенно независимо от канала.

### Требования

- Windows с хотя бы одним голосом SAPI (проверить: `Get-ChildItem` в реестре или
  `powershell -c "(New-Object -ComObject SAPI.SpVoice).GetVoices() | % { $_.GetDescription() }"`).
- Ничего скачивать не нужно, интернет не нужен.

### Установка

```powershell
node tools/apply-sapi-voice.mjs --dry-run
node tools/apply-sapi-voice.mjs
node tools/apply-sapi-voice.mjs --revert   # вернуть как было
```

| Опция | Значение |
|---|---|
| `--package <path>` | путь к установленному `dsh-pet` |
| `--user-data <path>` | куда положить `sapi/tts.ps1` (по умолчанию `%USERPROFILE%\.dsh\dsh-pet`) |
| `--dry-run` | только показать план |
| `--revert` | откатить последнюю установку |

**После установки полностью перезапустите DSH.**

### Ограничения

- Голос «настольный», без эмоций; на не-русской Windows нужен установленный русский голос SAPI,
  иначе будет читать английским.
- Задержка на фразу ~0,6–0,8 с (в основном запуск PowerShell), но только когда Edge недоступен:
  при живом Edge фраза идёт через него.

---

## 4. Локальный нейроголос Piper

### Проблема

SAPI разборчив, но звучит как «настольный голос из 2010-х» — слушать неприятно.

### Что делает патч

- создаёт venv и ставит `piper-tts` (+ onnxruntime), качает русскую модель `ru_RU-irina-medium`
  (~63 МБ) с HuggingFace;
- кладёт `piper_serve.py` — постоянный процесс: модель грузится один раз (~5 с), дальше каждая
  фраза синтезируется за **0,1–0,2 с**;
- в `lib/index.js` меняет порядок каналов: **Piper → SAPI → Edge**.

### Требования

- Python 3.9+ в PATH — только на время установки;
- ~110 МБ на диске (venv + модель), интернет — только при установке;
- дальше всё офлайн, VPN не нужен.

### Установка

```powershell
node tools/apply-piper-voice.mjs --dry-run
node tools/apply-piper-voice.mjs                   # женский голос irina
node tools/apply-piper-voice.mjs --voice dmitri    # мужской
node tools/apply-piper-voice.mjs --revert          # откатить патч бандла
```

| Опция | Значение |
|---|---|
| `--voice irina\|dmitri` | какую модель скачать (по умолчанию irina) |
| `--skip-setup` | не создавать venv и не качать модель (если уже есть) |
| `--package <path>` | путь к установленному `dsh-pet` |
| `--user-data <path>` | куда ставить piper (по умолчанию `%USERPROFILE%\.dsh\dsh-pet`) |
| `--dry-run` | только показать план |
| `--revert` | откатить патч бандла (venv и модель остаются) |

**После установки полностью перезапустите DSH.** Первая фраза — ~5–6 с (загрузка модели), дальше мгновенно.

### Голоса

Модель выбирается по `voiceName` из настроек питомца: если в нём есть «Dmitry» и скачан
`ru_RU-dmitri-medium.onnx` — берётся он, иначе `ru_RU-irina-medium`.

---

## 5. Озвучка: чистка разметки и фраза в конце задачи

Две правки, которые слышно.

**Разметка.** Модель любит ролевые вставки — `*фыркает*`, `*прищуривается*` — и «тильду» в конце
реплики (`~`). Раньше всё это уходило в синтез, и голос читал звёздочки и обрывки действий.
Теперь перед синтезом работает `sanitizeForSpeech` (и в авто-озвучке `speechSlice`, и в ручной
кнопке динамика `playManual`): действия вырезаются целиком, одиночные `*`, `~` и backticks
убираются, пробелы схлопываются. Если после чистки пусто — остаются слова без звёздочек.

**Финал задачи.** В конце задачи показывался только пузырь, без звука. Теперь терминальный статус
(`success` / `error`) проговаривается фразой из `workStatusTexts` — с учётом переключателя
«Озвучивание». Озвучиваются только финальные статусы, чтобы не болтала на каждый шаг.

### Установка

```powershell
node tools/apply-speech-fixes.mjs --dry-run
node tools/apply-speech-fixes.mjs
node tools/apply-speech-fixes.mjs --revert
```

Меняет `runtime/electron-helper/shared-core.js`, `runtime/electron-helper/events.js`,
`lib/client.js` и `src/shared/voice.ts`. После установки — перезапуск DSH или «Сохранить» в
настройках питомца (helper перезапустится).

---

## Применение через патчи

Если скрипты не подходят, те же изменения лежат в `patches/` (из корня пакета `dsh-pet`):

```powershell
git -c core.autocrlf=false apply -p1 patches/lib-index.patch
git -c core.autocrlf=false apply -p1 patches/src-voices.patch
git -c core.autocrlf=false apply -p1 patches/helper-menu.patch
git -c core.autocrlf=false apply -p1 patches/helper-shared-core.patch
git -c core.autocrlf=false apply -p1 patches/helper-sprite.patch
git -c core.autocrlf=false apply -p1 patches/local-sapi.patch
git -c core.autocrlf=false apply -p1 patches/local-sapi-edge-ts.patch
git -c core.autocrlf=false apply -p1 patches/local-sapi-route-ts.patch
git -c core.autocrlf=false apply -p1 patches/local-piper.patch
git -c core.autocrlf=false apply -p1 patches/speech-fixes.patch
```

`local-sapi*` сгенерированы от состояния «русские голоса уже добавлены», `local-piper.patch` — уже
от состояния «SAPI добавлен». На чистый 0.4.3 они тоже накладываются, но надёжнее соблюдать порядок:
`lib-index` → `local-sapi` → `local-piper`. Скрипт `apply-sapi-voice.mjs` дополнительно ставит
`sapi/tts.ps1`, `apply-piper-voice.mjs` — venv, модель и `piper_serve.py`; без них патчи бесполезны.

`-c core.autocrlf=false` обязателен: иначе git запишет файлы с CRLF и они перестанут совпадать
с оригиналом побайтово.

`speech-fixes.patch` независим от остальных: он про озвучку и накладывается на любой из состояний
(чистый 0.4.3 тоже подходит).

Проверено: все патчи применяются к чистому `dsh-pet@0.4.3` и дают побайтово те же файлы,
что и скрипты.

---

## Проверка голоса

1. Правый клик по питомцу → «Болтовня» (или «Поговорить»).
2. Лог:

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-pet\logs.txt" -Encoding UTF8 -Tail 5
```

Успешный синтез выглядит как `voice speak: cache=miss chars=... voice=edge ms=...` без слова `failed`.

## Ограничения

- Edge TTS периодически отвечает `429 Too Many Requests` — одна фраза пропускается молча, следующая звучит.
- Обновление `dsh-pet` через npm перезапишет `lib/index.js` и файлы helper'а; после обновления запустите скрипты заново.
- Патчи проверялись на `dsh-pet@0.4.3` (Windows 11, DSH desktop). На других версиях скрипты либо найдут
  свои маркеры и отработают, либо честно откажутся с сообщением.
- Бэкапы складываются рядом с изменяемыми файлами: `<package>\.ru-voices-backup\...` и
  `runtime/electron-helper\.ru-menu-backup\...`.

## Лицензия и атрибуция

MIT. Upstream: © 2026 PC2005-cloud, [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet).
Этот репозиторий — неофициальный патч и не связан с автором плагина.
