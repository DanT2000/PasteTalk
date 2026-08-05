package ru.appswire.pastetalk

import android.content.Context

/**
 * Что приложение помнит между запусками: адрес сервера и постоянный токен.
 *
 * Больше ничего и не нужно. Ни настроек распознавания, ни выбора модели —
 * всё это живёт в админке, а телефон только приносит голос.
 */
class Store(context: Context) {

    private val prefs = context.getSharedPreferences("pastetalk", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("url", "") ?: ""
        set(value) = prefs.edit().putString("url", value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value).apply()

    /** Подключено ли устройство. Без токена показывать главный экран незачем. */
    val connected: Boolean
        get() = serverUrl.isNotEmpty() && token.isNotEmpty()

    /** Забыть доступ: по кнопке в настройках или когда ключ отозвали. */
    fun forget() {
        prefs.edit().remove("token").apply()
    }
}
