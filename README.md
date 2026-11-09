# dsh-pet: русские голоса Edge

Неофициальный патч к [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) **0.4.3**, который добавляет
в белый список русские голоса Microsoft Edge TTS, чтобы питомец мог говорить по-русски.

## Проблема

В 0.4.3 в массиве `VOICES` только четыре китайских голоса (`zh-CN-*`). Если текст питомца русский,
Edge TTS получает китайский голос и русский текст и возвращает пустой ответ. В логе
`~/.dsh/dsh-pet/logs.txt` это выглядит так:

```
[warn] voice speak: failed chars=55 voice=edge ms=708
       reason=The service returned no audio. Voices are locale specific, ...
```

Сообщение сбивает с толку: та же ошибка приходит и когда сервис просто отдаёт `429`.
Итог один — питомец молчит, хотя `voiceEnabled`, громкость и шёпот включены.

## Что делает патч

| Файл | Изменение |
|---|---|
| `lib/index.js` | в `VOICES` добавляются `ru-RU-SvetlanaNeural` («Светлана», женский) и `ru-RU-DmitryNeural` («Дмитрий», мужской) |
| `src/host/voice/voices.ts` | то же в исходниках — если собираете плагин из source |
| `~/.dsh/dsh-pet/main-config.jsonc` | опционально: `voiceName` переключается на выбранный русский голос |

Скрипт идемпотентен: если голоса уже добавлены, он ничего не дублирует.

## Установка

```powershell
# посмотреть, что будет сделано (ничего не пишет)
node tools/apply-ru-voices.mjs --dry-run

# применить
node tools/apply-ru-voices.mjs

# применить и сразу поставить мужской голос
node tools/apply-ru-voices.mjs --voice ru-RU-DmitryNeural
```

Опции:

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

## Проверка

1. Правый клик по питомцу → «Болтовня» (или «Поговорить»).
2. Лог:

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-pet\logs.txt" -Encoding UTF8 -Tail 5
```

Успешный синтез выглядит как `voice speak: cache=miss chars=... voice=edge ms=...` без слова `failed`.

## Ограничения

- Edge TTS периодически отвечает `429 Too Many Requests` — одна фраза пропускается молча, следующая звучит.
- Обновление `dsh-pet` через npm перезапишет `lib/index.js`; после обновления запустите скрипт заново.
- Патч проверялся на `dsh-pet@0.4.3` (Windows 11, DSH desktop). На других версиях скрипт либо найдёт
  маркер `const VOICES = [` и отработает, либо честно откажется с сообщением.
- Бэкап оригинальных файлов делается автоматически в `<package>\.ru-voices-backup\<timestamp>\`.

## Лицензия и атрибуция

MIT. Upstream: © 2026 PC2005-cloud, [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet).
Этот репозиторий — неофициальный патч и не связан с автором плагина.
