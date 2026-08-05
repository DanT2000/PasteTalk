'use strict';

const { clipboard } = require('electron');
const log = require('./logger').scoped('paste');

/**
 * Положить текст в буфер и, если попросили, нажать Ctrl+V за человека.
 *
 * Нажатие идёт через SendInput из user32 — то же, чем пользуется сама
 * Windows. Панель записи специально создаётся неактивной, поэтому фокус
 * всё это время остаётся в чужом окне, и вставка попадает туда, куда надо.
 */

const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;
const INPUT_KEYBOARD = 1;

let sendInput = null;
let inputType = null;
let ready = false;

function init() {
  if (ready) return sendInput !== null;
  ready = true;
  try {
    const koffi = require('koffi');
    // INPUT на x64 занимает 40 байт: union выравнен по MOUSEINPUT, который
    // больше клавиатурного. Недостающее добиваем явными полями — иначе
    // SendInput молча ничего не сделает.
    inputType = koffi.struct('PT_INPUT', {
      type: 'uint32',
      _pad0: 'uint32',
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      _pad1: 'uint32',
      dwExtraInfo: 'uintptr',
      _pad2: 'uint64',
    });
    const user32 = koffi.load('user32.dll');
    sendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(inputType), 'int32']);
    return true;
  } catch (error) {
    sendInput = null;
    log.error(`не удалось подключить user32: ${error.message}`);
    return false;
  }
}

function key(vk, up) {
  return {
    type: INPUT_KEYBOARD,
    _pad0: 0,
    wVk: vk,
    wScan: 0,
    dwFlags: up ? KEYEVENTF_KEYUP : 0,
    time: 0,
    _pad1: 0,
    dwExtraInfo: 0,
    _pad2: 0n,
  };
}

function copy(text) {
  clipboard.writeText(text);
}

/** Ctrl+V в активное окно. true — нажатие ушло. */
function paste() {
  if (!init()) return false;
  const events = [
    key(VK_CONTROL, false),
    key(VK_V, false),
    key(VK_V, true),
    key(VK_CONTROL, true),
  ];
  try {
    const sent = sendInput(events.length, events, 40);
    if (sent !== events.length) {
      log.warn(`SendInput принял ${sent} из ${events.length} событий`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`SendInput не сработал: ${error.message}`);
    return false;
  }
}

/**
 * Положить текст и вставить. Между копированием и Ctrl+V нужна пауза:
 * приложение-получатель читает буфер не мгновенно.
 */
async function deliver(text, autoPaste) {
  copy(text);
  if (!autoPaste) return { pasted: false };
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { pasted: paste() };
}

module.exports = { copy, paste, deliver };
