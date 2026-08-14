# Политика безопасности / Security Policy

## Какие версии поддерживаются / Supported versions

Исправления безопасности выходят только для последней версии PasteTalk.
Обновитесь до свежего выпуска перед тем, как сообщать о проблеме.

Security fixes ship only for the latest PasteTalk release. Please update
to the newest version before reporting.

| Версия / Version | Поддержка / Supported |
| ---------------- | --------------------- |
| Последний выпуск / Latest release | ✅ |
| Все предыдущие / Older releases | ❌ |

## Как сообщить об уязвимости / Reporting a vulnerability

**Не создавайте публичные issues для уязвимостей.**
**Please do not open public issues for security vulnerabilities.**

Используйте приватную форму GitHub:
**Security → Report a vulnerability** — сообщение увидит только разработчик.

Use GitHub's private form: **Security → Report a vulnerability** — only the
maintainer will see it.

В сообщении желательно указать / Please include:

- версию PasteTalk и Windows / PasteTalk and Windows versions;
- шаги воспроизведения / steps to reproduce;
- чем это грозит на ваш взгляд / expected impact.

Ответ обычно в течение нескольких дней; исправление — следующим выпуском
с упоминанием в заметках (если вы не попросите об обратном).

You can expect a reply within a few days; a fix ships in the next release
with credit in the notes (unless you ask otherwise).

## Что важно знать об устройстве / Good to know

- Речь распознаётся локально и никуда не отправляется; серверный режим —
  только по явному выбору пользователя.
- Ключи и токены хранятся в `settings.json` на компьютере пользователя и
  никогда не покидают его: отчёты об ошибках вычищают их автоматически.
- Движок слушает только `127.0.0.1` и требует одноразовый токен.
