package dev.pidash.android

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import dev.pidash.g1.G1Glasses
import dev.pidash.g1.GlassesState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

data class WearSelection(val id: String? = null, val excerpt: String? = null, val version: Int = 0)

class DashApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var vault: Vault
        private set
    lateinit var repository: GatewayRepository
        private set
    val glassesState = MutableStateFlow(GlassesState())
    /** Glasses are connected and displaying; the service itself may also run for background monitoring alone. */
    val monitoring = MutableStateFlow(false)
    /** The user keeps the host connection and attention notifications after the GUI closes. */
    val background = MutableStateFlow(false)
    val wearSelection = MutableStateFlow(WearSelection())
    val attentionAlerts = MutableStateFlow(false)
    /** The prompt field's sentence capitalization option, kept between runs of the app. */
    val sentenceCapitalization = MutableStateFlow(true)
    var glasses: G1Glasses? = null
    private val notifier = AttentionNotifier()
    private val notifications: NotificationManager get() = getSystemService(NotificationManager::class.java)

    override fun onCreate() {
        super.onCreate()
        vault = Vault(this)
        repository = GatewayRepository(scope, vault)
        val prefs = display()
        prefs.edit().remove("channel").apply()
        attentionAlerts.value = prefs.getBoolean("attention", false)
        sentenceCapitalization.value = prefs.getBoolean("capitalize", true)
        background.value = prefs.getBoolean("background", false)
        wearSelection.value = WearSelection(prefs.getString("pin", null))
        notifications.createNotificationChannel(NotificationChannel(Channels.MONITOR, "Background monitoring", NotificationManager.IMPORTANCE_LOW).apply {
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setShowBadge(false)
        })
        notifications.createNotificationChannel(NotificationChannel(Channels.ATTENTION, "Sessions that need you", NotificationManager.IMPORTANCE_HIGH).apply {
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        // Notifications follow the dashboard whether or not a screen is open, so they belong to the app, not a service.
        scope.launch {
            repository.state.collect { state ->
                // No host state (unpaired, erased or re-paired) and switched-off monitoring both withdraw what is on screen.
                if (state.epoch == null || !background.value) { notifier.reset().forEach(::cancelAttention); return@collect }
                val update = notifier.update(state)
                update.alerts.forEach(::notifyAttention)
                update.cleared.forEach(::cancelAttention)
            }
        }
    }
    fun display(id: String? = null, excerpt: String? = null) {
        wearSelection.value = WearSelection(id, excerpt, wearSelection.value.version + 1)
        display().edit().putString("pin", id).apply()
    }
    fun alerts(enabled: Boolean) {
        attentionAlerts.value = enabled
        display().edit().putBoolean("attention", enabled).apply()
    }
    fun setBackground(enabled: Boolean) {
        background.value = enabled
        display().edit().putBoolean("background", enabled).apply()
        // Withdraw what is on screen when monitoring stops; the next start seeds silently.
        if (!enabled) notifier.reset().forEach(::cancelAttention)
    }
    fun setSentenceCapitalization(enabled: Boolean) {
        sentenceCapitalization.value = enabled
        display().edit().putBoolean("capitalize", enabled).apply()
    }
    private fun display() = getSharedPreferences("display", Context.MODE_PRIVATE)
    /** Names and status only, hidden while the phone is locked: never prompts, replies, addresses or tool output. */
    private fun notifyAttention(session: Session) {
        val open = PendingIntent.getActivity(this, Channels.attentionId(session.id), Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, Channels.ATTENTION)
            .setSmallIcon(R.drawable.ic_dash)
            .setContentTitle(session.label)
            .setContentText("${session.statusLabel} · ${session.project}")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        notifications.notify(Channels.attentionId(session.id), notification)
    }
    private fun cancelAttention(sessionId: String) { notifications.cancel(Channels.attentionId(sessionId)) }
}
