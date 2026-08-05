'use strict';

/**
 * Облачные провайдеры, доступные и компьютеру, и серверу.
 *
 * Поле stt отвечает на единственный вопрос, который стоит дорого: умеет ли
 * провайдер распознавать речь. У DeepSeek распознавания нет — если бы его
 * можно было выбрать аварийным, владелец узнал бы об этом ночью, когда с
 * телефона не получилось бы продиктовать.
 */

const CLOUD = {
  openai: {
    title: 'ChatGPT (OpenAI)',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    stt: true,
    defaultModel: 'gpt-4o-mini',
    defaultSttModel: 'whisper-1',
  },
  deepseek: {
    title: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    stt: false,
    defaultModel: 'deepseek-chat',
  },
  aitunnel: {
    title: 'AITunnel',
    kind: 'openai',
    baseUrl: 'https://api.aitunnel.ru/v1',
    needsKey: true,
    stt: true,
    defaultModel: 'deepseek-chat',
    defaultSttModel: 'whisper-large-v3-turbo',
  },
  custom: {
    title: 'Своё, OpenAI-совместимое',
    kind: 'openai',
    baseUrl: '',
    needsKey: false,
    stt: true,
  },
};

module.exports = { CLOUD };
