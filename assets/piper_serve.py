"""Постоянный процесс синтеза Piper для dsh-pet.

Модель грузится один раз (это ~5 с), дальше каждая фраза синтезируется за 0.1-0.2 с.
Протокол: построчно JSON в stdin, ответ построчно JSON в stdout.

  {"id": 1, "text": "Привет", "out": "C:/.../out.wav"}
  {"id": 1, "ok": true}
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config", default=None)
    args = parser.parse_args()

    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    try:
        from piper import PiperVoice

        voice = PiperVoice.load(args.model, config_path=args.config or (args.model + ".json"))
    except Exception as error:  # noqa: BLE001 - сообщаем плагину и выходим, он откатится на SAPI
        print(json.dumps({"id": 0, "ok": False, "error": "load: " + str(error)}), flush=True)
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            import wave

            with wave.open(request["out"], "wb") as wav_file:
                voice.synthesize_wav(request["text"], wav_file)
            print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"id": request.get("id"), "ok": False, "error": str(error)}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
