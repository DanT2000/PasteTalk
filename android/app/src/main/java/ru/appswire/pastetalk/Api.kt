package ru.appswire.pastetalk

import android.util.Base64
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
 *  возвращать человека на экран подключения. */
class AccessRevoked : IOException("Доступ отозван")

class Api(private val store: Store) {

    private fun open(path: String, timeoutMs: Int): HttpURLConnection {
        val base = store.serverUrl
            .replace(Regex("^wss:", RegexOption.IGNORE_CASE), "https:")
            .replace(Regex("^ws:", RegexOption.IGNORE_CASE), "http:")
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
        val json = if (text.isBlank()) JSONObject() else JSONObject(text)

        if (code == 401) throw AccessRevoked()
        if (code !in 200..299) {
            throw IOException(json.optString("error").ifBlank { "Сервер ответил $code" })
        }
        return json
    }

    /** Обменять шесть цифр на постоянный токен. */
    fun activate(url: String, code: String, title: String): String {
        store.serverUrl = url
        val connection = open("/v1/activate", 20_000)
        val answer = send(
            connection,
            JSONObject()
                .put("code", code)
                .put("kind", "android")
                .put("title", title),
        )
        val token = answer.optString("token")
        if (token.isBlank()) throw IOException("Сервер не выдал доступ")
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
        val connection = open("/v1/transcribe", 300_000)
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
        val connection = open("/v1/improve", 240_000)
        connection.setRequestProperty("Authorization", "Bearer ${store.token}")
        val answer = send(
            connection,
            JSONObject().put("text", text).put("mode", mode),
        )
        return answer.optString("text").trim()
    }
}
