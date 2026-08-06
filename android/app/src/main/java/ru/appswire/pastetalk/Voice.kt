package ru.appswire.pastetalk

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Запись голоса.
 *
 * M4A (AAC), 16 кГц, моно — ровно то, что нужно Whisper, и ничего сверх.
 * Минута занимает около 120 КБ, так что даже долгая диктовка уходит по
 * мобильному интернету без ожидания.
 */
class Voice(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var file: File? = null

    val busy: Boolean get() = recorder != null

    fun start() {
        stopQuietly()
        val target = File(context.cacheDir, "voice.m4a")
        target.delete()

        val fresh = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        try {
            fresh.apply {
                setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16_000)
                setAudioChannels(1)
                setAudioEncodingBitRate(32_000)
                setOutputFile(target.absolutePath)
                prepare()
                start()
            }
        } catch (error: Exception) {
            // Микрофон занят звонком или ассистентом. Не стартовавший
            // MediaRecorder всё равно надо освободить: каждое повторное
            // нажатие иначе копит неосвобождённые нативные ресурсы.
            fresh.release()
            target.delete()
            throw error
        }

        recorder = fresh
        file = target
    }

    /**
     * Остановить и отдать записанное.
     *
     * Пустой массив означает, что записи не вышло: слишком короткое нажатие
     * или микрофон занят. Бросать исключение тут нельзя — человек просто
     * нажал и отпустил, это не ошибка.
     */
    fun stop(): ByteArray {
        val current = recorder ?: return ByteArray(0)
        recorder = null
        return try {
            current.stop()
            current.release()
            file?.takeIf { it.exists() }?.readBytes() ?: ByteArray(0)
        } catch (error: RuntimeException) {
            // stop() бросается, если записать не успели ничего.
            current.release()
            ByteArray(0)
        }
    }

    fun cancel() {
        stopQuietly()
        file?.delete()
    }

    private fun stopQuietly() {
        val current = recorder ?: return
        recorder = null
        try {
            current.stop()
        } catch (error: RuntimeException) {
            // Уже остановлен или не начинал — освободить всё равно надо.
        }
        current.release()
    }
}
