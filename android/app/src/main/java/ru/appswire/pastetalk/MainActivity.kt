package ru.appswire.pastetalk

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
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

/**
 * Сетевые исключения по-человечески.
 *
 * Сообщения Java-исключений технические («Read timed out», «Unable to
 * resolve host…») — показывать их человеку, который и обычный текст читает
 * с трудом, нельзя.
 */
private fun humanError(context: Context, error: Throwable, fallback: String): String = when (error) {
    is java.net.SocketTimeoutException ->
        context.getString(R.string.error_timeout)
    is java.net.UnknownHostException, is java.net.ConnectException ->
        context.getString(R.string.error_no_connection)
    is javax.net.ssl.SSLException ->
        context.getString(R.string.error_ssl)
    else -> error.message ?: fallback
}

class MainActivity : ComponentActivity() {

    private lateinit var voice: Voice

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val store = Store(this)
        val api = Api(this, store)
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
            store = store,
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

/** Наш сервер — чтобы обычному человеку хватило одного кода. */
private const val OFFICIAL_SERVER = "https://pastetalk.dev.appswire.ru"

private enum class Provider { OURS, CUSTOM, CLOUD }

@Composable
private fun ProviderOption(title: Int, hint: Int, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) Color(0xFF2B2B33) else Color(0xFF232329),
        shape = MaterialTheme.shapes.medium,
        border = if (selected) BorderStroke(2.dp, ORANGE) else null,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                stringResource(title),
                fontSize = 19.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            )
            Text(stringResource(hint), fontSize = 15.sp, color = MUTED)
        }
    }
}

@Composable
private fun ConnectScreen(store: Store, api: Api, onDone: () -> Unit) {
    // Прошлые ответы берём из памяти: если ключ отозвали, человек
    // возвращается сюда, и набирать всё заново — издевательство.
    var provider by remember {
        mutableStateOf(
            when {
                store.mode == "cloud" && store.cloudUrl.isNotBlank() -> Provider.CLOUD
                store.serverUrl.isNotBlank() && store.serverUrl != OFFICIAL_SERVER -> Provider.CUSTOM
                else -> Provider.OURS
            },
        )
    }
    var url by remember { mutableStateOf(if (store.serverUrl == OFFICIAL_SERVER) "" else store.serverUrl) }
    var code by remember { mutableStateOf("") }
    var cloudUrl by remember { mutableStateOf(store.cloudUrl) }
    var cloudKey by remember { mutableStateOf("") }
    var cloudModel by remember { mutableStateOf(store.cloudModel) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.app_name), fontSize = 34.sp, fontWeight = FontWeight.Bold)

        // Провайдер — как в Bitwarden: по умолчанию наш сервер, и обычному
        // человеку хватает одного кода. Свой сервер и облако — ниже.
        Text(stringResource(R.string.provider_title), fontSize = 17.sp, color = MUTED)
        ProviderOption(R.string.provider_ours, R.string.provider_ours_hint, provider == Provider.OURS) {
            provider = Provider.OURS; error = ""
        }
        ProviderOption(R.string.provider_custom, R.string.provider_custom_hint, provider == Provider.CUSTOM) {
            provider = Provider.CUSTOM; error = ""
        }
        ProviderOption(R.string.provider_cloud, R.string.provider_cloud_hint, provider == Provider.CLOUD) {
            provider = Provider.CLOUD; error = ""
        }

        if (provider == Provider.CLOUD) {
            Text(stringResource(R.string.connect_intro_cloud), fontSize = 17.sp, color = MUTED)
            OutlinedTextField(
                value = cloudUrl,
                onValueChange = { cloudUrl = it },
                label = { Text(stringResource(R.string.cloud_url_label), fontSize = 17.sp) },
                placeholder = { Text("https://api.aitunnel.ru/v1", fontSize = 18.sp, color = MUTED) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = cloudKey,
                onValueChange = { cloudKey = it },
                label = { Text(stringResource(R.string.cloud_key_label), fontSize = 17.sp) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = cloudModel,
                onValueChange = { cloudModel = it },
                label = { Text(stringResource(R.string.cloud_model_label), fontSize = 17.sp) },
                placeholder = { Text("whisper-large-v3-turbo", fontSize = 18.sp, color = MUTED) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            Text(stringResource(R.string.connect_intro), fontSize = 17.sp, color = MUTED)
            if (provider == Provider.CUSTOM) {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text(stringResource(R.string.server_address_label), fontSize = 17.sp) },
                    placeholder = { Text(stringResource(R.string.server_address_placeholder), fontSize = 18.sp, color = MUTED) },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            OutlinedTextField(
                value = code,
                onValueChange = { fresh -> code = fresh.filter { it.isDigit() }.take(6) },
                label = { Text(stringResource(R.string.code_label), fontSize = 17.sp) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 26.sp),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (error.isNotEmpty()) {
            Text(error, fontSize = 18.sp, color = RED)
        }

        val ready = when (provider) {
            Provider.OURS -> code.length == 6
            Provider.CUSTOM -> code.length == 6 && url.isNotBlank()
            Provider.CLOUD -> cloudUrl.isNotBlank() && cloudKey.isNotBlank()
        }

        Button(
            onClick = {
                error = ""
                busy = true
                scope.launch {
                    val outcome = runCatching {
                        withContext(Dispatchers.IO) {
                            if (provider == Provider.CLOUD) {
                                // Сначала проверка, потом сохранение: опечатка
                                // в ключе должна всплыть здесь, а не после
                                // первой наговорённой минуты.
                                api.checkCloud(cloudUrl, cloudKey)
                                store.cloudUrl = cloudUrl
                                store.cloudKey = cloudKey
                                store.cloudModel = cloudModel
                                store.mode = "cloud"
                            } else {
                                val target = if (provider == Provider.OURS) OFFICIAL_SERVER else url
                                api.activate(target, code, Build.MODEL ?: context.getString(R.string.device_fallback))
                                store.mode = "server"
                            }
                        }
                    }
                    busy = false
                    outcome.fold(
                        onSuccess = { onDone() },
                        onFailure = { error = humanError(context, it, context.getString(R.string.connect_failed)) },
                    )
                }
            },
            enabled = !busy && ready,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp),
        ) {
            Text(
                when {
                    busy -> stringResource(R.string.connect_checking)
                    provider == Provider.CLOUD -> stringResource(R.string.cloud_save)
                    else -> stringResource(R.string.connect_button)
                },
                fontSize = 21.sp,
            )
        }
    }
}

// ---------- главный ----------

private enum class Stage { IDLE, RECORDING, THINKING, IMPROVING }

@Composable
private fun MainScreen(store: Store, api: Api, voice: Voice, onSettings: () -> Unit, onRevoked: () -> Unit) {
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
    // Отказали дважды — система больше не показывает диалог, и нажатия
    // на кнопку молча ничего не делали. Из этого тупика нужен выход.
    var deniedForever by remember { mutableStateOf(false) }

    val ask = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        mayRecord = granted
        if (!granted) {
            val activity = context as? ComponentActivity
            deniedForever =
                activity?.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) == false
            note = if (deniedForever) {
                context.getString(R.string.note_mic_denied_forever)
            } else {
                context.getString(R.string.note_mic_denied)
            }
        }
    }

    // Пока идёт запись, экран не гаснет: раньше телефон засыпал по своему
    // таймауту, Android останавливал приложение, и длинная диктовка
    // пропадала целиком — хотя человек просто говорил, не трогая экран.
    val view = LocalView.current
    LaunchedEffect(stage) {
        view.keepScreenOn = stage == Stage.RECORDING
    }

    // Свернули приложение, повернули телефон, ответили на звонок — запись
    // прервалась системой. Показываем это сразу, а не при нажатии.
    DisposableEffect(Unit) {
        MainActivity.onRecordingLost = {
            stage = Stage.IDLE
            note = context.getString(R.string.note_recording_lost)
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
            note = context.getString(R.string.note_recording_failed)
            return
        }
        stage = Stage.THINKING
        note = ""
        scope.launch {
            val outcome = runCatching {
                withContext(Dispatchers.IO) {
                    if (store.mode == "cloud") api.transcribeCloud(audio)
                    else api.transcribe(audio, recorded)
                }
            }
            stage = Stage.IDLE
            outcome.fold(
                onSuccess = { fresh ->
                    if (fresh.isBlank()) {
                        note = context.getString(R.string.note_nothing_recognized)
                    } else {
                        text = fresh
                        // Кладём в буфер сразу, как на компьютере: не
                        // заставлять человека делать лишнее движение.
                        copy(fresh)
                        note = context.getString(R.string.note_copied)
                    }
                },
                onFailure = { error ->
                    if (error is AccessRevoked) onRevoked()
                    else note = humanError(context, error, context.getString(R.string.error_generic))
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
                    note = context.getString(R.string.note_improved)
                },
                onFailure = { error ->
                    // Обычный текст остаётся при человеке: улучшение —
                    // надстройка, а не условие.
                    if (error is AccessRevoked) onRevoked()
                    else note = context.getString(
                        R.string.improve_failed,
                        humanError(context, error, context.getString(R.string.error_server_silent)),
                    )
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
            TextButton(onClick = onSettings) { Text(stringResource(R.string.settings), fontSize = 18.sp) }
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
                    // Человек мог только что дать разрешение в настройках
                    // телефона — перепроверяем, а не верим старому отказу.
                    mayRecord = ContextCompat.checkSelfPermission(
                        context, Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    when {
                        !mayRecord && deniedForever -> {
                            // Диалога больше не будет — ведём прямиком в
                            // настройки приложения, там разрешение включается.
                            context.startActivity(
                                Intent(
                                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.fromParts("package", context.packageName, null),
                                ),
                            )
                        }
                        !mayRecord -> ask.launch(Manifest.permission.RECORD_AUDIO)
                        stage == Stage.RECORDING -> finish()
                        stage == Stage.IDLE -> runCatching { voice.start() }
                            .onSuccess {
                                stage = Stage.RECORDING
                                note = ""
                            }
                            .onFailure { note = context.getString(R.string.note_mic_busy) }
                        else -> Unit
                    }
                },
            )
            Spacer(Modifier.height(20.dp))
            Text(
                when {
                    !mayRecord && deniedForever ->
                        stringResource(R.string.status_mic_denied_forever)
                    !mayRecord -> stringResource(R.string.status_mic_needed)
                    stage == Stage.RECORDING -> stringResource(R.string.status_recording)
                    stage == Stage.THINKING -> stringResource(R.string.status_thinking)
                    stage == Stage.IMPROVING -> stringResource(R.string.status_improving)
                    else -> stringResource(R.string.status_idle)
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
                // Занято на всё время работы, включая «Распознаю…»: нажатие
                // «Почистить» во время распознавания запускало второй запрос
                // наперегонки с первым, и свежая диктовка молча заменялась
                // причёсанной старой.
                busy = stage != Stage.IDLE,
                // Улучшение делает сервер PasteTalk; в облачном режиме его
                // нет — и кнопки, которые не работают, честнее не показывать.
                showImprove = store.mode != "cloud",
                onCopy = {
                    copy(text)
                    note = context.getString(R.string.note_copied)
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
                stringResource(R.string.record_seconds, seconds),
                fontSize = 44.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            else -> Text(
                stringResource(R.string.record_speak),
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold,
                color = DARK,
            )
        }
    }
}

@Composable
private fun ResultBlock(
    text: String,
    busy: Boolean,
    showImprove: Boolean,
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
            Text(stringResource(R.string.copy), fontSize = 20.sp)
        }

        // Названия те же, что на компьютере и в боте: одна кнопка не должна
        // в трёх местах называться по-разному. Пояснения под ними — потому
        // что «Почистить» само по себе ничего не говорит.
        if (showImprove) {
            OutlinedButton(
                onClick = { onImprove("clean") },
                enabled = !busy,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 58.dp),
            ) {
                Column(Modifier.padding(vertical = 6.dp)) {
                    Text(stringResource(R.string.improve_clean), fontSize = 19.sp)
                    Text(stringResource(R.string.improve_clean_hint), fontSize = 14.sp, color = MUTED)
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
                    Text(stringResource(R.string.improve_both), fontSize = 19.sp)
                    Text(stringResource(R.string.improve_both_hint), fontSize = 14.sp, color = MUTED)
                }
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
        Text(stringResource(R.string.settings), fontSize = 30.sp, fontWeight = FontWeight.Bold)

        Column {
            Text(stringResource(R.string.settings_provider), fontSize = 17.sp, color = MUTED)
            Text(
                when {
                    store.mode == "cloud" -> stringResource(R.string.provider_cloud)
                    store.serverUrl == OFFICIAL_SERVER -> stringResource(R.string.provider_ours)
                    else -> stringResource(R.string.provider_custom)
                },
                fontSize = 20.sp,
            )
        }

        Column {
            Text(
                stringResource(if (store.mode == "cloud") R.string.cloud_url_label else R.string.settings_server),
                fontSize = 17.sp,
                color = MUTED,
            )
            Text(
                (if (store.mode == "cloud") store.cloudUrl else store.serverUrl)
                    .ifBlank { stringResource(R.string.settings_server_none) },
                fontSize = 20.sp,
            )
        }

        Column {
            Text(stringResource(R.string.settings_status), fontSize = 17.sp, color = MUTED)
            Text(
                if (store.connected) stringResource(R.string.settings_connected)
                else stringResource(R.string.settings_disconnected),
                fontSize = 20.sp,
            )
        }

        Column {
            Text(stringResource(R.string.settings_version), fontSize = 17.sp, color = MUTED)
            Text(BuildConfig.VERSION_NAME, fontSize = 20.sp)
        }

        OutlinedButton(
            onClick = onForget,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Text(stringResource(R.string.settings_forget), fontSize = 19.sp)
        }

        Button(
            onClick = onBack,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 58.dp),
        ) {
            Text(stringResource(R.string.settings_back), fontSize = 20.sp)
        }
    }
}
