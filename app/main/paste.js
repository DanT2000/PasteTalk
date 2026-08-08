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

// ---------- окно «от администратора» ----------
//
// UIPI: Windows молча выбрасывает симулированный ввод, если активное окно
// принадлежит процессу с более высоким уровнем целостности — при этом
// SendInput честно возвращает успех. Человек видит «продиктовал, а не
// вставилось». Поэтому уровень чужого окна проверяется заранее, и вместо
// пустого нажатия человеку прямо говорят: текст в буфере, вставьте сами.

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_INTEGRITY_LEVEL = 25;

let uipi = null;        // функции WinAPI; null — проверка недоступна
let uipiReady = false;
let ownLevel = null;    // уровень нашего процесса, меняться ему не с чего

function initUipi() {
  if (uipiReady) return uipi;
  uipiReady = true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    uipi = {
      koffi,
      TML: koffi.struct('PT_TOKEN_MANDATORY_LABEL', { Sid: 'void*', Attributes: 'uint32' }),
      GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'void*', []),
      GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void*', koffi.out(koffi.pointer('uint32'))]),
      GetCurrentProcess: kernel32.func('__stdcall', 'GetCurrentProcess', 'void*', []),
      OpenProcess: kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'int32', 'uint32']),
      CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'int32', ['void*']),
      OpenProcessToken: advapi32.func('__stdcall', 'OpenProcessToken', 'int32', ['void*', 'uint32', koffi.out(koffi.pointer('void*'))]),
      GetTokenInformation: advapi32.func('__stdcall', 'GetTokenInformation', 'int32', ['void*', 'int32', 'void*', 'uint32', koffi.out(koffi.pointer('uint32'))]),
      GetSidSubAuthorityCount: advapi32.func('__stdcall', 'GetSidSubAuthorityCount', koffi.pointer('uint8'), ['void*']),
      GetSidSubAuthority: advapi32.func('__stdcall', 'GetSidSubAuthority', koffi.pointer('uint32'), ['void*', 'uint32']),
    };
  } catch (error) {
    uipi = null;
    log.warn(`проверка прав чужого окна недоступна: ${error.message}`);
  }
  return uipi;
}

/** Уровень целостности процесса: 0x2000 — обычный, 0x3000 — администратор. */
function integrityOf(processHandle) {
  const token = [null];
  if (!uipi.OpenProcessToken(processHandle, TOKEN_QUERY, token)) return null;
  try {
    const buffer = Buffer.alloc(128);
    const written = [0];
    if (!uipi.GetTokenInformation(token[0], TOKEN_INTEGRITY_LEVEL, buffer, buffer.length, written)) return null;
    const label = uipi.koffi.decode(buffer, uipi.TML);
    const count = uipi.koffi.decode(uipi.GetSidSubAuthorityCount(label.Sid), 'uint8');
    const level = uipi.koffi.decode(uipi.GetSidSubAuthority(label.Sid, count - 1), 'uint32');
    // label.Sid указывает ВНУТРЬ buffer. Это чтение — последнее обращение
    // к нему из JS: без него сборщик мусора вправе забрать буфер, пока по
    // указателям выше ещё идут нативные чтения.
    uipi.koffi.decode(buffer, 'uint8');
    return level;
  } finally {
    uipi.CloseHandle(token[0]);
  }
}

/**
 * Правда ли активное окно выше нас по правам.
 *
 * Любой сбой проверки — «нет»: пусть лучше нажатие уйдёт впустую, как
 * было всегда, чем исправная вставка перестанет работать из-за самой
 * проверки.
 */
function foregroundElevated() {
  if (!initUipi()) return false;
  try {
    if (ownLevel === null) ownLevel = integrityOf(uipi.GetCurrentProcess());
    if (ownLevel === null) return false;
    const hwnd = uipi.GetForegroundWindow();
    if (!hwnd) return false;
    const pid = [0];
    uipi.GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return false;
    const processHandle = uipi.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
    if (!processHandle) return false;
    try {
      const target = integrityOf(processHandle);
      return target !== null && target > ownLevel;
    } finally {
      uipi.CloseHandle(processHandle);
    }
  } catch (error) {
    log.warn(`не смог проверить права чужого окна: ${error.message}`);
    return false;
  }
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
  // Проверка прав — после паузы, вплотную к нажатию: фокус мог смениться,
  // пока буфер обмена устаканивался, и решать надо по свежему окну.
  if (foregroundElevated()) {
    log.info('активное окно запущено от администратора — Ctrl+V туда не дойдёт, текст остаётся в буфере');
    return { pasted: false, elevated: true };
  }
  return { pasted: paste() };
}

module.exports = { copy, paste, deliver };
