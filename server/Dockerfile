# Собирается из корня репозитория, а не из server/:
#   docker build -f server/Dockerfile -t pastetalk-server .
# Это нужно, чтобы в образ попала папка shared/ — общие с десктопом
# промпты лежат выше server/ ровно затем, чтобы не расходиться.
# Полный образ вместо slim — в нём уже есть python3, make и g++ для
# сборки better-sqlite3 из исходников. Проверено на живом сбое: у
# домашнего сервера разом пропали и зеркала Debian, и хранилище готовых
# сборок (обоих обслуживает Fastly), а реестр npm остался доступен — и
# только локальная компиляция из пакета не зависит ни от чего, кроме него.
FROM node:22

WORKDIR /app

# ffmpeg и yt-dlp — для ссылок в боте (VK Видео, YouTube, Rutube): запись
# скачивается на сервере и уходит в распознавание как обычное аудио.
# yt-dlp берём свежий с GitHub: сайты меняются, и версия из apt отстаёт
# на месяцы. Новый деплой = новый yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY shared/ ./shared/
COPY server/src/ ./server/src/

ENV NODE_ENV=production
ENV PASTETALK_DB=/data/pastetalk.db
ENV PORT=3000

# VOLUME здесь намеренно нет. Он создаёт безымянный том, который молча
# подменяет собой неправильно подключённый постоянный — и база тихо
# пересоздаётся при каждом развёртывании. Пусть монтированием ведает тот,
# кто разворачивает: в Coolify это «Persistent Storage» на /data.
EXPOSE 3000

CMD ["node", "server/src/index.js"]
