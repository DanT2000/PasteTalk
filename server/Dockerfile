# Собирается из корня репозитория, а не из server/:
#   docker build -f server/Dockerfile -t pastetalk-server .
# Это нужно, чтобы в образ попала папка shared/ — общие с десктопом
# промпты лежат выше server/ ровно затем, чтобы не расходиться.
FROM node:22-slim

# better-sqlite3 при отсутствии готовой сборки под платформу собирается
# из исходников, а для этого нужен компилятор. Но зеркала Debian с
# домашнего сервера временами недоступны, а готовая сборка под node:22
# у better-sqlite3 есть — поэтому неудача этого шага деплой не валит:
# если и компилятора нет, и готовой сборки не нашлось, честно упадёт
# npm ci строкой ниже.
RUN (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*) \
    || echo "зеркала Debian недоступны — рассчитываем на готовую сборку better-sqlite3"

WORKDIR /app

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
