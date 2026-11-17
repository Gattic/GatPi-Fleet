package dev.pidash.android

import android.Manifest
import android.app.Notification
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
import dev.pidash.g1.GlassesState
import dev.pidash.g1.TextPager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The one foreground service behind the GUI. Background monitoring (the persisted preference) keeps the
 * gateway connection and attention notifications alive after the app closes; the G1 display attaches and
 * detaches without ending it. Attention notifications themselves belong to the app, not this service.
 */
class MonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        fail("Monitoring stopped after an error: ${error.message?.take(120) ?: error.javaClass.simpleName}")
    })
    private val app get() = application as DashApp
    private val paint by lazy { Paint().apply { textSize = TextPager.FONT_SIZE; typeface = Typeface.DEFAULT } }
    private val cards by lazy { GlassesCards(TextPager(paint::measureText)) }
    private var wakeLock: PowerManager.WakeLock? = null
    private var stopping = false
    private var started = false
    private var glasses: G1Glasses? = null
    private var watch: Job? = null
    private var cap: Job? = null
    private var display: Job? = null
    private var releasing: Job? = null

    private fun fail(message: String) {
        app.setBackground(false)
        app.repository.message(message)
        stopSelf()
    }
    private fun glassesError(message: String) { app.glassesState.value = GlassesState(error = message) }
    private fun nearbyGranted() = checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
        checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_BACKGROUND -> { app.setBackground(false); if (glasses == null) stopSelf(); return START_NOT_STICKY }
            ACTION_STOP_GLASSES -> { releaseGlasses(); if (!app.background.value) stopSelf(); return START_NOT_STICKY }
        }
        // Every start request, including a repeated one, must enter the foreground within five seconds.
        startForeground(Channels.FOREGROUND_ID, notification())
        if (!started) {
            started = true
            app.repository.monitoring(true)
        }
        if (intent?.getBooleanExtra(EXTRA_GLASSES, false) == true && glasses == null) {
            if (nearbyGranted()) attachGlasses() else glassesError("Allow Nearby devices to connect your glasses.")
        }
        if (!app.background.value && glasses == null) { stopSelf(); return START_NOT_STICKY }
        return START_NOT_STICKY
    }

    /** Glasses pages follow the dashboard; the wake lock covers Bluetooth only, not plain background monitoring. */
    private fun startGlassesLoop(connected: G1Glasses) = scope.launch {
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
            connected.show(pages, explicit)
            delay(2000)
        }
    }

    private fun attachGlasses() {
        val connected = G1Glasses(this, scope)
        glasses = connected
        app.glasses = connected
        app.monitoring.value = true
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pi-dash:glasses").apply { acquire(GLASSES_CAP) }
        watch = scope.launch { connected.state.collect {
            if (!stopping && app.glasses === connected) {
                app.glassesState.value = it
                if (it.error != null) releaseGlasses()
            }
        } }
        connected.start()
        display = startGlassesLoop(connected)
        cap = scope.launch {
            delay(GLASSES_CAP - 5000)
            if (glasses === connected) {
                app.glassesState.value = app.glassesState.value.stopped().copy(error = "12-hour glasses session ended. Tap Connect to start a new session.")
                releaseGlasses()
            }
        }
    }

    /** Ends the glasses session only; background monitoring keeps running. Returns the arm-release job. */
    private fun releaseGlasses(): Job? {
        val connected = glasses ?: return null
        glasses = null
        watch?.cancel(); watch = null
        cap?.cancel(); cap = null
        display?.cancel(); display = null
        val terminal = app.glassesState.value
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        app.glasses = null
        app.monitoring.value = false
        // Keep a terminal error visible on the Glasses screen after cleanup, as before.
        app.glassesState.value = terminal.stopped()
        releasing = scope.launch {
            try { connected.stop() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { app.glassesState.value = app.glassesState.value.copy(error = "Glasses release failed: ${e.message ?: "unknown error"}") }
        }
        return releasing
    }

    /** Android requires a foreground-service notification; keep it minimal and free of actions. */
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, Channels.MONITOR).setSmallIcon(R.drawable.ic_dash)
            .setContentTitle("pi-dash monitoring").setContentText("Background monitoring is on · stop under Pairing")
            .setContentIntent(open).setSilent(true).setShowWhen(false).setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            // Not ongoing: Android 13+ lets the user dismiss it while the service keeps running.
            .setOngoing(false).setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    override fun onDestroy() {
        if (!stopping) {
            stopping = true
            val released = releaseGlasses() ?: releasing
            scope.launch {
                // Let the arms be released before the scope and the gateway connection go away.
                released?.join()
                app.monitoring.value = false
                app.repository.monitoring(false)
                scope.cancel()
            }
        }
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP_BACKGROUND = "dev.pidash.STOP_BACKGROUND"
        const val ACTION_STOP_GLASSES = "dev.pidash.STOP_GLASSES"
        const val EXTRA_GLASSES = "glasses"
        private const val GLASSES_CAP = 12 * 60 * 60 * 1000L
    }
}
