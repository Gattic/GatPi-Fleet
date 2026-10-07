package dev.pidash.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Paint
import android.graphics.Typeface
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import dev.pidash.g1.G1Glasses
import dev.pidash.g1.TextPager
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class GlassesService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, _ ->
        fail("Glasses monitoring stopped after a Bluetooth error. Check permissions and tap Connect again.")
    })
    private val app get() = application as DashApp
    private var lock: PowerManager.WakeLock? = null
    private var stopping = false
    private var started = false
    private var ownedGlasses: G1Glasses? = null
    private fun fail(message: String) {
        app.glassesState.value = app.glassesState.value.copy(error = message)
        stopSelf()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopSelf(); return START_NOT_STICKY }
        if (started) return START_NOT_STICKY
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            fail("Allow Nearby devices to connect your glasses."); return START_NOT_STICKY
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Glasses monitoring", NotificationManager.IMPORTANCE_LOW).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE })
        startForeground(1, notification())
        started = true
        lock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pi-dash:glasses").apply { acquire(12 * 60 * 60 * 1000L) }
        val glasses = G1Glasses(this, scope)
        ownedGlasses = glasses
        app.glasses = glasses
        app.monitoring.value = true
        app.repository.monitoring(true)
        val paint = Paint().apply { textSize = TextPager.FONT_SIZE; typeface = Typeface.DEFAULT }
        val cards = GlassesCards(TextPager(paint::measureText))
        scope.launch { glasses.state.collect {
            if (!stopping && app.glasses === glasses) {
                app.glassesState.value = it
                if (it.error != null) stopSelf()
            }
        } }
        glasses.start()
        scope.launch {
            val policy = AttentionPolicy()
            var selectionVersion = -1
            var alert: Session? = null
            var alertUntil = 0L
            while (isActive) {
                val state = app.repository.state.value
                val selection = app.wearSelection.value
                val now = System.nanoTime() / 1_000_000
                val explicit = selectionVersion != selection.version
                if (explicit) { alert = null; selectionVersion = selection.version }
                policy.next(state, app.attentionAlerts.value, now)?.let { alert = it; alertUntil = now + 10_000 }
                val pages = when {
                    !state.fresh -> cards.overview(state)
                    alert != null && now < alertUntil -> cards.attention(state, alert!!)
                    selection.excerpt != null -> cards.excerpt(selection.excerpt)
                    selection.id != null -> cards.session(state, selection.id)
                    else -> cards.overview(state)
                }
                glasses.show(pages, explicit)
                delay(2000)
            }
        }
        // End visibly before the wake-lock cap instead of leaving a silent, stale monitoring service.
        scope.launch { delay(12 * 60 * 60 * 1000L - 5000); fail("12-hour glasses session ended. Tap Connect to start a new session.") }
        return START_NOT_STICKY
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, GlassesService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_dash).setContentTitle("pi-dash glasses monitoring")
            .setContentText("Local session status · tap to open · Stop to release glasses")
            .setContentIntent(open).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "Stop", stop).build()
    }
    override fun onDestroy() {
        if (!stopping) {
            stopping = true
            val glasses = ownedGlasses
            val terminalState = app.glassesState.value
            scope.launch {
                try { glasses?.stop() }
                finally {
                    if (lock?.isHeld == true) lock?.release()
                    lock = null
                    if (app.glasses === glasses) {
                        app.glasses = null
                        app.monitoring.value = false
                        app.repository.monitoring(false)
                        app.glassesState.value = terminalState.stopped()
                    }
                    scope.cancel()
                }
            }
        }
        super.onDestroy()
    }
    companion object { const val STOP = "dev.pidash.STOP_GLASSES"; private const val CHANNEL = "glasses-monitoring" }
}
