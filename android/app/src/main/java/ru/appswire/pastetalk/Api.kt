package ru.appswire.pastetalk

import android.content.Context
import android.util.Base64
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Разговор с сервером PasteTalk.
 *
 * HttpURLConnection вместо библиотеки: запросов всего три, а каждая лишняя
 * зависимость — лишний повод сборке сломаться через год.
 */

/** Ключ отозвали. Отдельный тип, потому что на него надо не ругаться, а
 *  возвращать человека на экран подключения. Текст приходит снаружи:
 *  строки живут в ресурсах, а ресурсы — у контекста. */
class AccessRevoked(message: String) : IOException(message)

class Api(private val context: Context, private val store: Store) {

    /**
     * Привести адрес к виду, с которым соединение вообще возможно.
     *
     * Человек набирает адрес руками и чаще всего без «https://» — а без
     * схемы URL() бросает английское «no protocol», прочитать которое
     * нельзя. «http://» переписываем на «https://»: обычный трафик всё
     * равно запрещён настройками безопасности — кроме адресов эмулятора,
     * на которых живёт разработка.
     */
    private fun normalize(raw: String): String {
        val given = raw.trim().trimEnd('/')
            .replace(Regex("^wss:", RegexOption.IGNORE_CASE), "https:")
            .replace(Regex("^ws:", RegexOption.IGNORE_CASE), "http:")
        val withScheme = if (given.contains("://")) given else "https://$given"
        val local = Regex("^http://(10\\.0\\.2\\.2|localhost|127\\.0\\.0\\.1)([:/]|$)", RegexOption.IGNORE_CASE)
        return if (local.containsMatchIn(withScheme)) withScheme
        else withScheme.replace(Regex("^http:", RegexOption.IGNORE_CASE), "https:")
    }

    private fun open(path: String, timeoutMs: Int): HttpURLConnection {
        val base = normalize(store.serverUrl)
        return (URL("$base$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = timeoutMs
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
    }

    private fun send(connection: HttpURLConnection, body: JSONObject): JSONObject {
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        // Пока контейнер сервера перезапускается, вместо JSON приходит
        // HTML-страница «502 Bad Gateway» от прокси. Падать на её разборе
        // нельзя: человек увидел бы «Value <html> of type…» вместо ответа.
        val json = if (text.isBlank()) JSONObject() else try {
            JSONObject(text)
        } catch (broken: JSONException) {
            JSONObject()
        }

        if (code == 401) throw AccessRevoked(context.getString(R.string.error_access_revoked))
        if (code !in 200..299) {
            throw IOException(json.optString("error").ifBlank {
                if (code in 500..599) context.getString(R.string.error_server_unavailable)
                else context.getString(R.string.error_server_status, code)
            })
        }
        if (text.isNotBlank() && json.length() == 0) {
            throw IOException(context.getString(R.string.error_server_garbled))
        }
        return json
    }

    /** Обменять шесть цифр на постоянный токен. */
    fun activate(url: String, code: String, title: String): String {
        // В память кладём уже приведённый адрес: пусть и в настройках, и
        // при повторной привязке он выглядит так, как реально используется.
        store.serverUrl = normalize(url)
        val connection = open("/v1/activate", 20_000)
        val answer = send(
            connection,
            JSONObject()
                .put("code", code)
                .put("kind", "android")
                .put("title", title),
        )
        val token = answer.optString("token")
        if (token.isBlank()) throw IOException(context.getString(R.string.error_no_token))
        store.token = token
        return token
    }

    /**
     * Звук на входе, текст на выходе.
     *
     * Длительность шлём свою: m4a сервер измерить не умеет, а провайдер её
     * возвращать не обязан — без неё расход считался бы нулём, и телефон,
     * главный сценарий, был бы невидим в админке.
     */
    fun transcribe(audio: ByteArray, seconds: Int): String {
        // Дольше, чем любой законный путь на сервере: задача домашнему
        // компьютеру живёт до десяти минут, плюс очередь. Раньше телефон
        // сдавался на пятой минуте — сервер доделывал работу и списывал
        // расход, а результат доставался никому.
        val connection = open("/v1/transcribe", 660_000)
        connection.setRequestProperty("Authorization", "Bearer ${store.token}")
        val answer = send(
            connection,
            JSONObject()
                .put("audio", Base64.encodeToString(audio, Base64.NO_WRAP))
                .put("filename", "voice.m4a")
                .put("seconds", seconds),
        )
        return answer.optString("text").trim()
    }

    /** Причесать уже полученный текст. Сервер его у себя не хранит, поэтому
     *  посылаем целиком. */
    fun improve(text: String, mode: String): String {
        // Как и распознавание — с запасом над серверными пределами.
        val connection = open("/v1/improve", 660_000)
        connection.setRequestProperty("Authorization", "Bearer ${store.token}")
        val answer = send(
            connection,
            JSONObject().put("text", text).put("mode", mode),
        )
        return answer.optString("text").trim()
    }
}
