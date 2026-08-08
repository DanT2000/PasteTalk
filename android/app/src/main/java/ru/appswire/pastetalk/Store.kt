package ru.appswire.pastetalk

import android.content.Context

/**
 * Что приложение помнит между запусками.
 *
 * Два способа работать: через сервер PasteTalk (адрес + постоянный токен,
 * выданный по коду) или напрямую в облачный API по своему ключу — без
 * сервера вовсе. Настройки распознавания при серверном пути живут в
 * админке; при облачном человек сам вписал адрес, ключ и модель.
 */
class Store(context: Context) {

    private val prefs = context.getSharedPreferences("pastetalk", Context.MODE_PRIVATE)

    /** Как работаем: "server" — через сервер PasteTalk, "cloud" — напрямую. */
    var mode: String
        get() = prefs.getString("mode", "server") ?: "server"
        set(value) = prefs.edit().putString("mode", value).apply()

    var serverUrl: String
        get() = prefs.getString("url", "") ?: ""
        set(value) = prefs.edit().putString("url", value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value).apply()

    var cloudUrl: String
        get() = prefs.getString("cloudUrl", "") ?: ""
        set(value) = prefs.edit().putString("cloudUrl", value.trim().trimEnd('/')).apply()

    var cloudKey: String
        get() = prefs.getString("cloudKey", "") ?: ""
        set(value) = prefs.edit().putString("cloudKey", value.trim()).apply()

    var cloudModel: String
        get() = prefs.getString("cloudModel", "") ?: ""
        set(value) = prefs.edit().putString("cloudModel", value.trim()).apply()

    /** Готово ли приложение к работе — по выбранному пути. */
    val connected: Boolean
        get() = if (mode == "cloud") cloudUrl.isNotEmpty() && cloudKey.isNotEmpty()
        else serverUrl.isNotEmpty() && token.isNotEmpty()

    /**
     * Забыть доступ: по кнопке в настройках или когда ключ отозвали.
     * Адреса остаются — набирать их заново было бы издевательством.
     */
    fun forget() {
        prefs.edit().remove("token").remove("cloudKey").apply()
    }
}
