# dsh-pet: русские голоса и локализация меню

Два независимых патча к [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) **0.4.3**:

1. **Русские голоса Edge** — чтобы питомец мог говорить по-русски, а не только по-китайски.
2. **Русская локализация меню** — правый клик по питомцу и подписи горячих клавиш в desktop-helper.

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

## Применение через патчи

Если скрипты не подходят, те же изменения лежат в `patches/` (из корня пакета `dsh-pet`):

```powershell
git -c core.autocrlf=false apply -p1 patches/lib-index.patch
git -c core.autocrlf=false apply -p1 patches/src-voices.patch
git -c core.autocrlf=false apply -p1 patches/helper-menu.patch
git -c core.autocrlf=false apply -p1 patches/helper-shared-core.patch
git -c core.autocrlf=false apply -p1 patches/helper-sprite.patch
```

`-c core.autocrlf=false` обязателен: иначе git запишет файлы с CRLF и они перестанут совпадать
с оригиналом побайтово.

Проверено: все пять патчей применяются к чистому `dsh-pet@0.4.3` и дают побайтово те же файлы,
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
