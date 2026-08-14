'use strict';

/**
 * Словарь перевода серверных страниц: витрины и админки.
 *
 * Русский — источник: HTML и строки в JS остаются русскими, а при
 * английском языке готовый DOM обходится и заменяется по этому словарю.
 * Ключ — русский текст с нормализованными пробелами (см. t() на страницах),
 * значение — английский. Один словарь на обе страницы: он маленький, а
 * общие строки («Админка», «на связи») не приходится держать дважды.
 */
window.PASTETALK_EN = {
  // ---------- отчёты об ошибках ----------
  'Отчёты об ошибках': 'Error reports',
  'Приходят из настольной программы по кнопке «Отправить разработчику»: журнал работы, настройки без ключей, сведения о системе':
    'Sent from the desktop app via "Send to developer": work log, settings without keys, system info',
  'Пока пусто — и это хорошо': 'Nothing yet — and that is good news',
  'Показать': 'Show',
  'Загружаю…': 'Loading…',
  'Удалить': 'Delete',
  'Отчёты не загрузились:': 'Reports failed to load:',

  // ---------- витрина ----------
  'PasteTalk — голос в текст, локально': 'PasteTalk — voice to text, locally',
  'Диктовка по горячей клавише. Речь распознаётся на вашем компьютере и не уходит в интернет.':
    'Hotkey dictation. Speech is recognized on your computer and never goes online.',
  'Админка': 'Admin',
  'Говорите — получайте текст': 'Speak. Get text.',
  'Нажали горячую клавишу, сказали вслух, отпустили — текст уже в буфере обмена. Речь распознаётся прямо на вашем компьютере и никуда не отправляется.':
    'Press the hotkey, say it out loud, release — the text is already on your clipboard. Speech is recognized right on your computer and never leaves it.',
  'Скачать для Windows': 'Download for Windows',
  'Исходный код': 'Source code',
  'Бесплатно, с открытым кодом, лицензия MIT.': 'Free, open source, MIT license.',
  'Ничего не уходит в интернет': 'Nothing goes online',
  'Whisper работает на вашей видеокарте. Ни записи, ни текста никто, кроме вас, не увидит.':
    'Whisper runs on your GPU. No one but you ever sees the recording or the text.',
  'Причёсывает сказанное': 'Tidies up what you say',
  'Языковая модель убирает «эээ» и повторы. Обычный текст попадает в буфер сразу, не дожидаясь её.':
    'A language model strips the "umm"s and repetitions. The plain transcript lands in your clipboard right away, without waiting for it.',
  'Крупнее, если нужно': 'Larger, if you need it',
  'Масштаб интерфейса 100, 125 или 150 %. Программа задумывалась для человека со слабым зрением.':
    'UI scale of 100, 125, or 150%. The app was built with a low-vision user in mind.',
  'С телефона и из Telegram': 'From your phone and Telegram',
  'Этот сервер даёт диктовать откуда угодно, а считает всё тот же домашний компьютер.':
    'This server lets you dictate from anywhere, while the same home computer does the actual work.',
  'Как подключить телефон или Telegram': 'How to connect a phone or Telegram',
  'Возьмите код.': 'Get a code.',
  'Владелец выдаёт шестизначный код в админке.': 'The owner issues a six-digit code in the admin panel.',
  'Введите его.': 'Enter it.',
  'В приложении на телефоне или прямо в Telegram-боте.': 'In the phone app or right in the Telegram bot.',
  'Диктуйте.': 'Dictate.',
  'Код одноразовый: на второе устройство владелец выдаёт новый.':
    'The code is single-use: for a second device the owner issues a new one.',
  'Пока домашний компьютер на связи, всё считается на нём и не стоит ничего. Когда он выключен, диктовка уходит в облако.':
    "While the home computer is online, everything runs on it and costs nothing. When it's off, dictation goes to the cloud.",
  'Исходный код и сборка': 'Source code and builds',

  // ---------- админка: вход ----------
  'PasteTalk — админка': 'PasteTalk — Admin',
  'Вход в панель': 'Sign in',
  'Пароль': 'Password',
  'Войти': 'Sign in',
  'Придумайте пароль': 'Choose a password',
  'Панель ещё никем не занята. Первый пароль, который вы здесь введёте, станет настоящим — запоминать заводской не нужно, его нет.':
    "The panel isn't claimed yet. The first password you enter here becomes the real one — there's no factory password to remember.",
  'Сделайте это сейчас: панель раздаёт коды доступа и хранит ключи провайдеров, а занять её может любой, кто знает адрес.':
    'Do it now: the panel hands out access codes and stores provider keys, and anyone who knows the address can claim it.',
  'Ваш пароль': 'Your password',
  'Занять панель': 'Claim the panel',
  'Сессия истекла, войдите заново': 'Session expired — sign in again',
  'Нужно войти заново': 'Please sign in again',
  'Сервер ответил': 'Server replied',

  // ---------- админка: шапка и вкладки ----------
  'компьютер: …': 'computer: …',
  'бот: …': 'bot: …',
  'компьютер:': 'computer:',
  'бот:': 'bot:',
  'работает': 'running',
  'выключен': 'off',
  'Расход': 'Spending',
  'Люди': 'People',
  'Компьютер': 'Computer',
  'Настройки': 'Settings',

  // ---------- единицы и мелочи ----------
  'мин': 'min',
  'ч': 'h',
  'с': 's',
  'мс': 'ms',
  'обр.': 'req.',

  // ---------- расход ----------
  'Пока не о чем рисовать.': 'Nothing to chart yet.',
  ': свой': ': own',
  'мин, облако': 'min, cloud',
  'Минуты диктовки по дням за последний месяц': 'Dictation minutes per day over the last month',
  'Облаком пока не пользовались — платить не за что.': "The cloud hasn't been used yet — nothing to pay for.",
  'Через свой компьютер': 'On your own computer',
  'бесплатно': 'free',
  'Через облако': 'Through the cloud',
  'Своим железом': 'On your own hardware',
  'от всей диктовки за месяц': 'of all dictation this month',
  'По дням': 'By day',
  'свой компьютер': 'own computer',
  'облако': 'cloud',
  'за последние 30 дней': 'last 30 days',
  'По моделям за месяц': 'By model this month',
  'Оценка по своему прайсу: провайдеры фактическую стоимость не присылают':
    "Estimated from your own price list: providers don't report actual costs",

  // ---------- люди ----------
  'Телефон': 'Phone',
  'Вот код доступа к PasteTalk:': 'Here is your access code for PasteTalk:',
  'В Telegram: откройте': 'In Telegram: open',
  ', нажмите «Начать» и пришлите этот код одним сообщением.':
    ', tap "Start" and send this code as one message.',
  'В приложении на телефоне: адрес сервера': 'In the phone app: server address',
  ', ниже этот код, кнопка «Подключиться».': ', this code below it, then the "Connect" button.',
  'Код одноразовый и действует ограниченное время — если не успеете, попросите новый.':
    "The code is single-use and short-lived — if you miss the window, ask for a new one.",
  'Код для «': 'Code for "',
  '»:': '":',
  'скопировать код': 'copy code',
  'скопировать инструкцию': 'copy instructions',
  'Второй раз он не покажется — передайте сейчас.': "It won't be shown again — pass it on now.",
  'скопировано': 'copied',
  'действует ещё': 'valid for another',
  'использован': 'used',
  'устарел': 'expired',
  'код устарел': 'code expired',
  'никто ещё не вошёл': 'no one has signed in yet',
  'отвязать': 'unlink',
  '(отозван)': '(revoked)',
  'новый код': 'new code',
  'телеграм вручную': 'Telegram by hand',
  'удалить': 'delete',
  'Выдать доступ': 'Grant access',
  'Здесь только люди. Компьютеры, которые считают за других, живут во вкладке «Компьютеры». Код одноразовый: сработал — исчез. Одно устройство — один профиль, чтобы потом было видно, откуда пришёл доступ. Нужны телефон и телеграм — заведите «Мама, телефон» и «Мама, телеграм».':
    'People only. Computers that do the work for others live in the "Computers" tab. Codes are single-use: once used, gone. One device — one profile, so you can always tell where access came from. Need both a phone and Telegram? Create "Mom, phone" and "Mom, Telegram".',
  'Мама, телефон': 'Mom, phone',
  'действует 10 минут': 'valid for 10 minutes',
  '30 минут': '30 minutes',
  '1 час': '1 hour',
  'сутки': '24 hours',
  'Выдать код': 'Issue a code',
  'Кто пользуется': "Who's using it",
  'Профиль': 'Profile',
  'Код': 'Code',
  'За месяц': 'This month',
  'Устройства': 'Devices',
  'Пока никого. Выдайте первый код выше.': 'No one yet. Issue the first code above.',
  'Удалить профиль? Все его устройства перестанут работать сразу.':
    'Delete this profile? All of its devices stop working immediately.',
  'Номер человека в Telegram. Он узнаёт его командой /id в самом боте.':
    "The person's Telegram ID. They can get it with the /id command in the bot.",

  // ---------- компьютеры ----------
  'порядок': 'order',
  'на связи': 'online',
  'не на связи': 'offline',
  'пинг': 'ping',
  'выше': 'up',
  'ниже': 'down',
  'новый ключ': 'new key',
  'Добавить компьютер': 'Add a computer',
  'Компьютер — не человек: у него постоянный ключ, а не разовый код. Задача уходит первой машине по порядку; не взялась за полминуты — следующей, и только потом в облако.':
    "A computer isn't a person: it gets a permanent key, not a one-time code. A job goes to the first machine in order; if it doesn't pick it up within half a minute, it goes to the next one, and only then to the cloud.",
  'Домашний ПК': 'Home PC',
  'Добавить': 'Add',
  'Машины': 'Machines',
  'Имя': 'Name',
  'Состояние': 'Status',
  'Последний отклик': 'Last seen',
  'Задач': 'Jobs',
  'Пока ни одной. Добавьте выше — получите ключ для PasteTalk.':
    'None yet. Add one above and get a key for PasteTalk.',
  'Как подключить': 'How to connect',
  'На компьютере: PasteTalk → Настройки → Интеграция. Адрес этого сервера, ключ из списка выше, включить «Работать как агент сервера».':
    'On the computer: PasteTalk → Settings → Integration. This server\'s address, a key from the list above, and turn on "Act as a server agent".',
  'Спрашиваю…': 'Asking…',
  'Ответил за': 'Replied in',
  'Выпустить новый ключ? Прежний перестанет работать сразу.':
    'Issue a new key? The old one stops working immediately.',
  'Удалить компьютер? Он отключится сразу.': 'Delete this computer? It disconnects immediately.',
  'Ключ для «': 'Key for "',
  'скопировать': 'copy',
  'Показывается один раз — вставьте его в PasteTalk сейчас.':
    'Shown only once — paste it into PasteTalk now.',

  // ---------- настройки ----------
  'Telegram-бот': 'Telegram bot',
  'Бот опрашивает Telegram.': 'The bot is polling Telegram.',
  'Люди с кодом могут присылать ему голосовые.': 'People with a code can send it voice messages.',
  'Бот выключен. Впишите токен от @BotFather — он начнёт отвечать сразу, перезапуск не нужен.':
    'The bot is off. Paste a token from @BotFather — it starts replying right away, no restart needed.',
  'Токен бота': 'Bot token',
  'ключ задан — оставьте пустым, чтобы не менять': 'key is set — leave empty to keep it',
  'не задан': 'not set',
  'Берётся у @BotFather. Чтобы выключить бота — впишите минус и сохраните':
    'Issued by @BotFather. To turn the bot off, enter a minus sign and save',
  'Перезапустить бота': 'Restart the bot',
  'Перезапускаю…': 'Restarting…',
  'Бот перезапущен и опрашивает': 'Bot restarted and polling',
  'Бот выключен: токен не задан': 'Bot is off: no token set',
  'Прокси': 'Proxy',
  'Нужен, если отсюда не достучаться до Telegram: без прокси опрос падает с «fetch failed», и бот молчит. Поддерживается HTTP-прокси; логин и пароль вписываются прямо в адрес.':
    'Needed when Telegram is unreachable from here: without a proxy, polling fails with "fetch failed" and the bot goes silent. HTTP proxies are supported; username and password go right into the address.',
  'Адрес прокси': 'Proxy address',
  'Например, http://логин:пароль@1.vpn.appswire.ru:8080. Минус — выключить':
    'For example, http://user:password@1.vpn.appswire.ru:8080. A minus sign turns it off',
  'Что пускать через прокси': 'What goes through the proxy',
  'только Telegram': 'Telegram only',
  'Telegram и облачных провайдеров': 'Telegram and cloud providers',
  'Гонять через чужой канал звук людей без нужды не стоит: AITunnel и так доступен напрямую':
    "No point routing people's audio through someone else's channel: AITunnel is reachable directly anyway",
  'Проверить прокси': 'Check the proxy',
  'Проверяю…': 'Checking…',
  'Telegram отвечает через прокси за': 'Telegram replies through the proxy in',
  'Облако: провайдеры, модели и цены': 'Cloud: providers, models, and prices',
  'Облако подхватывает работу, когда домашний компьютер выключен или занят — пока он на связи, платные провайдеры не трогаются. У каждого провайдера здесь всё своё: ключ, модели и цены. По этим ценам считается расход — сам провайдер стоимость не присылает, цифры берутся из его тарифов. Пустая модель — стандартная, пустая цена — расход по этой модели считается нулём. Работа домашнего компьютера бесплатна, её модели в ценах не нуждаются — поэтому они видны в расходе, но не здесь.':
    "The cloud picks up the work when the home computer is off or busy — while it's online, paid providers aren't touched. Each provider keeps its own things here: key, models, and prices. Spending is calculated from these prices — providers don't report actual costs, so the numbers come from their published rates. An empty model means the default one; an empty price means spending for that model counts as zero. The home computer works for free and its models need no prices — that's why they appear in spending but not here.",
  'речь и текст': 'speech and text',
  'только текст': 'text only',
  'Ключ': 'Key',
  'Берётся в личном кабинете провайдера. Минус — стереть':
    "Found in your provider's dashboard. A minus sign clears it",
  'Если сервис работает без ключа — оставьте пустым. Минус — стереть':
    'If the service needs no key, leave this empty. A minus sign clears it',
  'Адрес сервера': 'Server address',
  'https://адрес/v1': 'https://host/v1',
  'OpenAI-совместимый. Пусто — провайдер не используется':
    "OpenAI-compatible. Empty — the provider isn't used",
  'Модель распознавания': 'Speech model',
  '₽ за минуту звука': '₽ per minute of audio',
  'имя модели': 'model name',
  'Модель текста': 'Text model',
  '₽ вход, 1 млн ток.': '₽ input, 1M tokens',
  '₽ выход, 1 млн ток.': '₽ output, 1M tokens',
  'Кого спрашивать в облаке': 'Who to ask in the cloud',
  'Порядок на случай сбоя: задача идёт основному провайдеру, не ответил — запасному. «Никто» в основном — облака для этой работы нет вовсе, сервер будет ждать домашний компьютер.':
    'Failover order: a job goes to the primary provider; if it doesn\'t answer, to the backup. "No one" as primary means no cloud for this job at all — the server will wait for the home computer.',
  '— никто —': '— no one —',
  'основной': 'primary',
  'запасной': 'backup',
  'Распознавание речи': 'Speech recognition',
  'Улучшение текста': 'Text cleanup',
  'Промпты улучшения': 'Cleanup prompts',
  'Это действующие промпты кнопок «Почистить» и «Почистить и переписать» — везде: в боте, с телефона и на домашнем компьютере, когда задача пришла с сервера. Правьте текст прямо здесь — копируйте, дописывайте, переделывайте. Хвост «':
    'These are the live prompts behind the "Clean up" and "Clean up and rewrite" buttons — everywhere: in the bot, from the phone, and on the home computer when the job came from the server. Edit the text right here — copy, extend, rework. The tail "',
  '» сервер дописывает сам к любому варианту.': '" is appended by the server to every variant.',
  'Почистить': 'Clean up',
  'Осторожная правка: убрать паразитов и ошибки, ничего не переписывая':
    'Careful editing: remove filler words and slips without rewriting anything',
  'Почистить и переписать': 'Clean up and rewrite',
  'Полная переработка: собрать мысли и сделать текст письменным':
    'Full rework: pull the thoughts together and turn them into written prose',
  'Вернуть стандартный': 'Restore default',
  'Когда домашний компьютер занят': 'When the home computer is busy',
  'Ждать очереди или уходить в облако': 'Wait in line or go to the cloud',
  'ждать 30 секунд, потом в облако': 'wait 30 seconds, then go to the cloud',
  'всегда ждать компьютер, денег не тратить': 'always wait for the computer, spend nothing',
  'Облако стоит копейки, но избавляет от «оно висит». Второй вариант — если платить не хочется совсем':
    'The cloud costs pennies but spares you the "it\'s stuck" feeling. Pick the second if you\'d rather not pay at all',
  'Сохранить': 'Save',
  'Сохраняю…': 'Saving…',
  'Сохранено, бот опрашивает': 'Saved, the bot is polling',
  'Сохранено': 'Saved',
  'Не сохранилось:': "Couldn't save:",

  // ---------- частые ответы сервера ----------
  'Пароль не подходит': 'Wrong password',
  'Панель уже занята — войдите своим паролем': 'The panel is already claimed — sign in with your password',
  'Панель ещё не занята — придумайте пароль': "The panel isn't claimed yet — choose a password",
  'Пароль короче 8 знаков': 'Password is shorter than 8 characters',
  'Такого компьютера нет': 'No such computer',
  'Имя не может быть пустым': 'The name cannot be empty',
  'Такого профиля нет': 'No such profile',
  'Такого кода нет': 'No such code',
  'Код устарел. Попросите новый': 'The code has expired. Ask for a new one',
  'ПК не на связи': 'PC is offline',
  'ПК не ответил вовремя': "PC didn't respond in time",
  'Прокси не задан': 'No proxy set',
  'Компьютеры теперь в своём разделе — заведите машину там':
    'Computers have their own section now — add the machine there',
  'Не указан номер в телеграме': 'No Telegram ID given',
  'Не удалось подобрать свободный код': "Couldn't find a free code",
  'Доступ': 'Access',
  'Telegram-бот': 'Telegram bot',
  'только по коду': 'code holders only',
  'открыт для всех': 'open to everyone',
  '«Открыт для всех» — любой пишет боту без кода, расход гостей виден в профиле «Гости бота». Выключили — гости теряют доступ сразу, привязанные по коду остаются':
    '"Open to everyone" — anyone can message the bot without a code; guest spending shows up under the "Гости бота" profile. Turn it off and guests lose access instantly, code holders keep working',
  'Новые привязки по коду': 'New code sign-ups',
  'разрешены': 'allowed',
  'закрыты': 'closed',
  '«Закрыты» — коды не принимаются ни в приложениях, ни в боте. Все, кто уже привязан, продолжают работать как раньше':
    '"Closed" — codes are rejected in the apps and the bot alike. Everyone already linked keeps working as before',
  '(служебный: расход открытого бота)': '(service profile: open-bot spending)',
};
