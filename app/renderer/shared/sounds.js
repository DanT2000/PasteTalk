'use strict';

/**
 * Сигналы начала и конца записи.
 *
 * Синтезируем на месте, а не носим с собой wav-файлы: восемь коротких
 * звуков — это восемь строк кода и ноль мегабайт в установщике, а
 * громкость и высота настраиваются без переэкспорта.
 */

/**
 * Ноты в герцах по равномерному строю: чистые интервалы звучат заметно
 * приятнее случайно подобранных частот. Каждый пресет — короткий мотив
 * из двух-трёх нот, а не одиночный писк.
 *
 * `partials` задаёт тембр: набор обертонов и их громкости. Именно они
 * отличают «колокольчик» от «деревяшки», а не форма волны.
 */
const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.5, G6 = 1568;

const PRESETS = {
  bell: {
    title: 'Колокольчик',
    partials: [[1, 1], [2.76, 0.34], [5.4, 0.12]],   // как у настоящего колокола
    notes: [[C6, 0, 0.9], [G6, 0.075, 0.55]],
    decay: 0.75, attack: 0.004,
  },
  marimba: {
    title: 'Маримба',
    partials: [[1, 1], [4, 0.2], [10, 0.05]],
    notes: [[C5, 0, 1], [G5, 0.06, 0.8], [C6, 0.12, 0.6]],
    decay: 0.42, attack: 0.003,
  },
  soft: {
    title: 'Мягкий',
    partials: [[1, 1], [2, 0.28]],
    notes: [[E5, 0, 0.9], [A5, 0.07, 0.7]],
    decay: 0.5, attack: 0.02,
  },
  glass: {
    title: 'Стекло',
    partials: [[1, 1], [3.01, 0.42], [7.2, 0.16]],
    notes: [[E6, 0, 0.85]],
    decay: 0.9, attack: 0.002,
  },
  drop: {
    title: 'Капля',
    partials: [[1, 1], [2, 0.15]],
    notes: [[C6, 0, 0.9], [G5, 0.045, 0.8]],
    decay: 0.32, attack: 0.002,
  },
  wood: {
    title: 'Деревяшка',
    partials: [[1, 1], [3.4, 0.5], [6.1, 0.25]],
    notes: [[D5, 0, 1]],
    decay: 0.14, attack: 0.001,
  },
  chime: {
    title: 'Перезвон',
    partials: [[1, 1], [2, 0.3], [3, 0.1]],
    notes: [[G5, 0, 0.8], [C6, 0.08, 0.8], [E6, 0.16, 0.6]],
    decay: 0.6, attack: 0.005,
  },
  tick: {
    title: 'Тик',
    partials: [[1, 1], [5.8, 0.6]],
    notes: [[A5 * 2, 0, 0.7]],
    decay: 0.05, attack: 0.001,
  },
  crystal: {
    title: 'Хрусталь',
    partials: [[1, 1], [2.9, 0.35], [6.4, 0.18], [9.7, 0.08]],
    notes: [[E6, 0, 0.8], [A5 * 2, 0.09, 0.5]],
    decay: 1.1, attack: 0.002,
  },
  harp: {
    title: 'Арфа',
    partials: [[1, 1], [2, 0.45], [3, 0.2], [4, 0.08]],
    notes: [[C5, 0, 0.9], [E5, 0.07, 0.8], [G5, 0.14, 0.7], [C6, 0.21, 0.6]],
    decay: 0.7, attack: 0.004,
  },
  kalimba: {
    title: 'Калимба',
    partials: [[1, 1], [6.27, 0.12], [12.1, 0.04]],
    notes: [[G5, 0, 1], [C6, 0.09, 0.75]],
    decay: 0.5, attack: 0.002,
  },
  flute: {
    title: 'Флейта',
    partials: [[1, 1], [2, 0.12], [3, 0.05]],
    notes: [[E5, 0, 0.85], [G5, 0.12, 0.7]],
    decay: 0.55, attack: 0.05,
  },
  bubble: {
    title: 'Пузырёк',
    partials: [[1, 1], [2, 0.2]],
    notes: [[G5, 0, 0.7], [E6, 0.05, 0.9]],
    decay: 0.18, attack: 0.003,
  },
  box: {
    title: 'Шкатулка',
    partials: [[1, 1], [4.2, 0.3], [8, 0.1]],
    notes: [[C6, 0, 0.8], [E6, 0.09, 0.65], [G6, 0.18, 0.55]],
    decay: 0.65, attack: 0.003,
  },
  none: null,
};

let context = null;

function audio() {
  if (!context) context = new AudioContext();
  if (context.state === 'suspended') context.resume();
  return context;
}

/**
 * @param {string} preset  имя из PRESETS
 * @param {number} volume  0..100
 * @param {boolean|string} variant  true — начало записи, false — конец
 *   (тот же мотив задом наперёд и ниже), 'done' — «улучшение готово»:
 *   спокойное разрешение из двух нот тем же тембром.
 */
function playSound(preset, volume, variant = true) {
  const recipe = PRESETS[preset];
  if (!recipe || !volume) return;

  const ctx = audio();
  const out = ctx.createGain();
  out.gain.value = Math.min(volume, 100) / 100 * 0.3;

  // Лёгкий низкочастотный срез: без него обертоны звенят в ушах,
  // особенно в наушниках и на большой громкости.
  const soften = ctx.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 7000;
  out.connect(soften);
  soften.connect(ctx.destination);

  // Конец записи — тот же мотив, но задом наперёд и ниже. Так два
  // сигнала не спутать, даже не глядя на экран. «Готово» — своя пара нот:
  // мягкий подъём с разрешением, тише и неторопливее сигналов записи.
  const done = variant === 'done';
  const rising = done ? true : Boolean(variant);
  const notes = done
    ? [[G5, 0, 0.5], [C6, 0.12, 0.7]]
    : (rising ? recipe.notes : [...recipe.notes].reverse());
  const shift = rising ? 1 : 0.75;
  const attack = done ? Math.max(recipe.attack, 0.015) : recipe.attack;
  const decay = done ? recipe.decay * 1.25 : recipe.decay;
  const step = done ? 0.12 : (recipe.notes[1]?.[1] ?? 0.07);

  notes.forEach(([frequency, _offset, loudness], index) => {
    const at = ctx.currentTime + index * step;
    for (const [ratio, weight] of recipe.partials) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency * shift * ratio;

      // Обертоны затухают быстрее основного тона — так звучит всё, что
      // звенит в природе, и именно это отличает звук от синтетического писка.
      const life = decay / (1 + (ratio - 1) * 0.55);
      const peak = weight * (loudness ?? 1);
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(peak, at + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, at + attack + life);

      osc.connect(env);
      env.connect(out);
      osc.start(at);
      osc.stop(at + attack + life + 0.02);
    }
  });
}

window.pastetalkSounds = { playSound, PRESETS };
