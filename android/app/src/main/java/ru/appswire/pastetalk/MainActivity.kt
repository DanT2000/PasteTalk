package ru.appswire.pastetalk

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Всё приложение — три экрана: подключение, главный, настройки.
 *
 * Размеры текста везде в sp и намеренно крупные: программу читает человек
 * со слабым зрением, и системное увеличение шрифта должно работать поверх
 * этого. Поэтому ни одного размера текста в dp здесь нет.
 */

private val ORANGE = Color(0xFFE9A72C)
private val DARK = Color(0xFF1B1B1F)
private val MUTED = Color(0xFFA0A0AC)
private val RED = Color(0xFFF2686C)

class MainActivity : ComponentActivity() {

    private lateinit var voice: Voice

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val store = Store(this)
        val api = Api(store)
        voice = Voice(this)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = ORANGE, background = DARK)) {
                Surface(color = MaterialTheme.colorScheme.background) {
                    // Android 15 при targetSdk 35 рисует окно от края до
                    // края. Без этого отступа «Настройки» уезжают под
                    // системную панель, и нажать их становится нельзя.
                    Box(Modifier.safeDrawingPadding()) {
                        Root(store, api, voice)
                    }
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        // Ушли из приложения посреди записи — микрофон отпускаем. Экран об
        // этом обязан узнать: иначе человек вернётся к красной кнопке и
        // бегущему счётчику, нажмёт «закончить» и получит пустоту вместо
        // двух минут речи.
        if (voice.busy) {
            voice.cancel()
            onRecordingLost?.invoke()
        }
    }

    companion object {
        /** Кто-то на экране должен знать, что запись оборвалась. */
        var onRecordingLost: (() -> Unit)? = null
    }
}

@Composable
private fun Root(store: Store, api: Api, voice: Voice) {
    var connected by remember { mutableStateOf(store.connected) }
    var inSettings by remember { mutableStateOf(false) }

    when {
        !connected -> ConnectScreen(store, api) { connected = true }
        inSettings -> SettingsScreen(
            store = store,
            onBack = { inSettings = false },
            onForget = {
                store.forget()
                connected = false
                inSettings = false
            },
        )
        else -> MainScreen(
            api = api,
            voice = voice,
            onSettings = { inSettings = true },
            onRevoked = {
                store.forget()
                connected = false
            },
        )
    }
}

// ---------- подключение ----------

@Composable
private fun ConnectScreen(store: Store, api: Api, onDone: () -> Unit) {
    // Адрес берём из памяти: если ключ отозвали, человек возвращается сюда,
    // и заставлять его набирать тот же адрес заново — издевательство.
    // В первый раз он пуст, и там подсказка, а не подставленный чужой адрес.
    var url by remember { mutableStateOf(store.serverUrl) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text("PasteTalk", fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Text(
            "Чтобы начать, введите код доступа. Его выдаёт владелец сервера.",
            fontSize = 19.sp,
            color = MUTED,
        )

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Адрес сервера", fontSize = 17.sp) },
            placeholder = { Text("https://ваш-сервер.ru", fontSize = 18.sp, color = MUTED) },
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = code,
            onValueChange = { fresh -> code = fresh.filter { it.isDigit() }.take(6) },
            label = { Text("Код из шести цифр", fontSize = 17.sp) },
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 26.sp),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        if (error.isNotEmpty()) {
            Text(error, fontSize = 18.sp, color = RED)
        }

        Button(
            onClick = {
                error = ""
                busy = true
                scope.launch {
                    val outcome = runCatching {
                        withContext(Dispatchers.IO) {
                            api.activate(url, code, Build.MODEL ?: "Телефон")
                        }
                    }
                    busy = false
                    outcome.fold(
                        onSuccess = { onDone() },
                        onFailure = { error = it.message ?: "Не удалось подключиться" },
                    )
                }
            },
            enabled = !busy && code.length == 6 && url.isNotBlank(),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp),
        ) {
            Text(if (busy) "Проверяю…" else "Подключиться", fontSize = 21.sp)
        }
    }
}

// ---------- главный ----------

private enum class Stage { IDLE, RECORDING, THINKING, IMPROVING }

@Composable
private fun MainScreen(api: Api, voice: Voice, onSettings: () -> Unit, onRevoked: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var stage by remember { mutableStateOf(Stage.IDLE) }
    var text by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var seconds by remember { mutableIntStateOf(0) }
    var mayRecord by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED,
        )
    }

    val ask = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> mayRecord = granted }

    // Свернули приложение, повернули телефон, ответили на звонок — запись
    // прервалась системой. Показываем это сразу, а не при нажатии.
    DisposableEffect(Unit) {
        MainActivity.onRecordingLost = {
            stage = Stage.IDLE
            note = "Запись прервалась — приложение уходило в фон"
        }
        onDispose { MainActivity.onRecordingLost = null }
    }

    // Счётчик секунд: человек должен видеть, что запись идёт, а не гадать.
    LaunchedEffect(stage) {
        if (stage != Stage.RECORDING) return@LaunchedEffect
        seconds = 0
        while (true) {
            delay(1000)
            seconds += 1
        }
    }

    fun copy(value: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("PasteTalk", value))
    }

    fun finish() {
        // Секунды запомним до сброса счётчика: сервер сам их не измерит.
        val recorded = seconds
        val audio = voice.stop()
        if (audio.isEmpty()) {
            stage = Stage.IDLE
            note = "Запись не получилась — попробуйте ещё раз"
            return
        }
        stage = Stage.THINKING
        note = ""
        scope.launch {
            val outcome = runCatching { withContext(Dispatchers.IO) { api.transcribe(audio, recorded) } }
            stage = Stage.IDLE
            outcome.fold(
                onSuccess = { fresh ->
                    if (fresh.isBlank()) {
                        note = "Ничего не разобрал"
                    } else {
                        text = fresh
                        // Кладём в буфер сразу, как на компьютере: не
                        // заставлять человека делать лишнее движение.
                        copy(fresh)
                        note = "Текст скопирован"
                    }
                },
                onFailure = { error ->
                    if (error is AccessRevoked) onRevoked()
                    else note = error.message ?: "Что-то не вышло"
                },
            )
        }
    }

    fun improve(mode: String) {
        if (text.isBlank()) return
        stage = Stage.IMPROVING
        note = ""
        scope.launch {
            val outcome = runCatching { withContext(Dispatchers.IO) { api.improve(text, mode) } }
            stage = Stage.IDLE
            outcome.fold(
                onSuccess = { fresh ->
                    text = fresh
                    copy(fresh)
                    note = "Готово, скопировано"
                },
                onFailure = { error ->
                    // Обычный текст остаётся при человеке: улучшение —
                    // надстройка, а не условие.
                    if (error is AccessRevoked) onRevoked()
                    else note = "Причесать не вышло: ${error.message}"
                },
            )
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onSettings) { Text("Настройки", fontSize = 18.sp) }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            RecordButton(
                stage = stage,
                seconds = seconds,
                onClick = {
                    when {
                        !mayRecord -> ask.launch(Manifest.permission.RECORD_AUDIO)
                        stage == Stage.RECORDING -> finish()
                        stage == Stage.IDLE -> runCatching { voice.start() }
                            .onSuccess {
                                stage = Stage.RECORDING
                                note = ""
                            }
                            .onFailure { note = "Микрофон занят другой программой" }
                        else -> Unit
                    }
                },
            )
            Spacer(Modifier.height(20.dp))
            Text(
                when {
                    !mayRecord -> "Нужно разрешить запись"
                    stage == Stage.RECORDING -> "Идёт запись — нажмите, чтобы закончить"
                    stage == Stage.THINKING -> "Распознаю…"
                    stage == Stage.IMPROVING -> "Причёсываю…"
                    else -> "Нажмите и говорите"
                },
                fontSize = 20.sp,
                textAlign = TextAlign.Center,
            )
            if (note.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text(note, fontSize = 17.sp, color = MUTED, textAlign = TextAlign.Center)
            }
        }

        if (text.isNotEmpty()) {
            ResultBlock(
                text = text,
                busy = stage == Stage.IMPROVING,
                onCopy = {
                    copy(text)
                    note = "Текст скопирован"
                },
                onImprove = { mode -> improve(mode) },
            )
        }
    }
}

@Composable
private fun RecordButton(stage: Stage, seconds: Int, onClick: () -> Unit) {
    val recording = stage == Stage.RECORDING
    val working = stage == Stage.THINKING || stage == Stage.IMPROVING

    Box(
        modifier = Modifier
            .size(200.dp)
            .clip(CircleShape)
            .background(if (recording) RED else ORANGE)
            .clickable(enabled = !working, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        when {
            working -> CircularProgressIndicator(color = DARK, strokeWidth = 5.dp)
            recording -> Text(
                "$seconds с",
                fontSize = 44.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            else -> Text("Говорить", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = DARK)
        }
    }
}

@Composable
private fun ResultBlock(
    text: String,
    busy: Boolean,
    onCopy: () -> Unit,
    onImprove: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 360.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            color = Color(0xFF232329),
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f, fill = false),
        ) {
            Text(
                text,
                fontSize = 21.sp,
                lineHeight = 30.sp,
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .clickable(onClick = onCopy)
                    .padding(16.dp),
            )
        }

        Button(
            onClick = onCopy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Text("Копировать", fontSize = 20.sp)
        }

        // Названия те же, что на компьютере и в боте: одна кнопка не должна
        // в трёх местах называться по-разному. Пояснения под ними — потому
        // что «Почистить» само по себе ничего не говорит.
        OutlinedButton(
            onClick = { onImprove("clean") },
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("Почистить", fontSize = 19.sp)
                Text("Уберёт «эээ», повторы и оговорки", fontSize = 14.sp, color = MUTED)
            }
        }

        OutlinedButton(
            onClick = { onImprove("both") },
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("Почистить и переписать", fontSize = 19.sp)
                Text("Сделает текст письменным: абзацы, связные фразы", fontSize = 14.sp, color = MUTED)
            }
        }
    }
}

// ---------- настройки ----------

@Composable
private fun SettingsScreen(store: Store, onBack: () -> Unit, onForget: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text("Настройки", fontSize = 30.sp, fontWeight = FontWeight.Bold)

        Column {
            Text("Сервер", fontSize = 17.sp, color = MUTED)
            Text(store.serverUrl.ifBlank { "не указан" }, fontSize = 20.sp)
        }

        Column {
            Text("Состояние", fontSize = 17.sp, color = MUTED)
            Text(if (store.connected) "Подключено" else "Не подключено", fontSize = 20.sp)
        }

        Column {
            Text("Версия", fontSize = 17.sp, color = MUTED)
            Text(BuildConfig.VERSION_NAME, fontSize = 20.sp)
        }

        OutlinedButton(
            onClick = onForget,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Text("Отвязать это устройство", fontSize = 19.sp)
        }

        Button(
            onClick = onBack,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Text("Назад", fontSize = 20.sp)
        }
    }
}
