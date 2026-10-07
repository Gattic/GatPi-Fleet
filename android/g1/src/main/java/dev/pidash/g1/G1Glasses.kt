// Orchestration adapted from G1 PoC; packet/GATT details retain the tested upstream layout.
package dev.pidash.g1

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.EnumMap

// The owning service checks runtime permissions before creating or starting this transport.
@SuppressLint("MissingPermission")
class G1Glasses(private val context: Context, private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow(GlassesState())
    val state: StateFlow<GlassesState> = mutable
    private val arms = EnumMap<Side, G1Arm>(Side::class.java)
    private val devices = EnumMap<Side, BluetoothDevice>(Side::class.java)
    private val requests = Channel<Unit>(Channel.CONFLATED)
    private var session: Job? = null
    private var renderer: Job? = null
    private var pages: List<String> = emptyList()
    private var textSeq = 0
    private var discovery: G1Discovery? = null

    fun selectPair(channel: String): Boolean = discovery?.choose(channel) == true

    fun start() {
        check(session == null) { "Glasses monitoring already started" }
        mutable.value = GlassesState(session = "Scanning for G1 pairs (20 seconds)…")
        renderer = scope.launch {
            for (ignored in requests) {
                val version = mutable.value.displayRevision
                val number = mutable.value.page
                if (number == 0) {
                    for (arm in arms.values.filter { it.ready }) {
                        try { arm.request(G1Protocol.exit(), 1500) }
                        catch (error: IOException) { G1Diagnostics.record("Exit not acknowledged") }
                    }
                    continue
                }
                if (mutable.value.silent || mutable.value.dismissed || arms.size != 2 || arms.values.any { !it.ready }) continue
                val copy = pages
                if (number !in 1..copy.size) continue
                var acknowledged = false
                for (attempt in 1..3) {
                    if (mutable.value.displayRevision != version || mutable.value.silent || mutable.value.dismissed) break
                    if (sendPage(copy, number, version)) { acknowledged = true; break }
                }
                mutable.update { it.finishDisplay(version, acknowledged) }
            }
        }
        session = scope.launch {
            try {
                devices.putAll(discoverPair())
                mutable.update { it.copy(session = "connecting") }
                // Initial connection and recovery are independent: one temple's
                // connect timeout must not stop its peer's heartbeat.
                coroutineScope { for (side in Side.entries) launch {
                    var missed = 0
                    var seq = 0
                    while (true) {
                        try {
                            if (arms[side]?.ready != true) {
                                connect(side); requests.trySend(Unit); missed = 0
                                if (arms.size == 2 && arms.values.all { it.ready }) mutable.update { it.copy(session = "connected") }
                            }
                            val arm = arms.getValue(side)
                            val answer = arm.request(G1Protocol.heartbeat(seq++), 1500)
                            if (answer != null && G1Protocol.isHeartbeatAck(answer)) missed = 0 else missed++
                            if (missed >= 3) { arm.close(); setArm(side, "lost"); mutable.update { it.copy(session = "recovering").pendingDisplay() } }
                        } catch (error: IOException) {
                            arms[side]?.close()
                            setArm(side, "reconnecting: ${error.message?.take(120)}"); mutable.update { it.copy(session = "recovering").pendingDisplay() }
                        }
                        delay(8000)
                    }
                } }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: SecurityException) { fail("Bluetooth permission revoked. Allow Nearby devices and tap Connect again.") }
            catch (error: IOException) { fail(error.message ?: "Glasses connection failed. Check Bluetooth and tap Connect again.") }
            catch (_: Exception) { fail("Glasses connection failed. Check Bluetooth and tap Connect again.") }
        }
    }
    private fun fail(message: String) {
        releaseArms()
        mutable.update { it.stopped().copy(error = message) }
        G1Diagnostics.record("Connection stopped with an error")
    }
    private suspend fun connect(side: Side) {
        setArm(side, "connecting")
        val arm = arms.getOrPut(side) { G1Arm(side, devices.getValue(side), context, ::event) { lost ->
            scope.launch { setArm(lost, "disconnected"); mutable.update { it.pendingDisplay() } }
        } }
        arm.connect()
        arm.request(G1Protocol.connectedHello(), 1000)
        setArm(side, "ready")
    }
    /** Automatic refreshes do not reopen a dismissed screen. Only a phone action may do that. */
    fun show(newPages: List<String>, explicit: Boolean = false) {
        require(newPages.isNotEmpty() && newPages.size <= 3)
        if (!explicit && mutable.value.dismissed) return
        if (!explicit && pages == newPages) return
        pages = newPages
        mutable.update { it.copy(page = if (explicit) 1 else it.page.coerceIn(1, newPages.size), pageCount = newPages.size, dismissed = if (explicit) false else it.dismissed).pendingDisplay() }
        requests.trySend(Unit)
    }
    fun page(delta: Int) {
        if (pages.isEmpty()) return
        val next = (mutable.value.page + delta).coerceIn(1, pages.size)
        if (next == mutable.value.page && !mutable.value.dismissed) return
        mutable.update { it.copy(page = next, dismissed = false).pendingDisplay() }
        requests.trySend(Unit)
    }
    fun hide() {
        mutable.update { it.copy(page = 0, dismissed = true).pendingDisplay() }
        requests.trySend(Unit)
    }
    private suspend fun sendPage(copy: List<String>, number: Int, version: Long): Boolean {
        val packets = G1Protocol.textPackets(copy[number - 1], textSeq++, number, copy.size)
        for (side in Side.entries) for (packet in packets) {
            if (version != mutable.value.displayRevision || mutable.value.silent || mutable.value.dismissed) return false
            val arm = arms[side]?.takeIf { it.ready } ?: return false
            val answer = try { arm.request(packet, 2000) } catch (_: IOException) { return false }
            if (answer == null || !G1Protocol.isAck(answer)) return false
        }
        return true
    }
    private fun event(side: Side, frame: ByteArray) {
        val event = G1Protocol.decodeEvent(frame) ?: return
        G1Diagnostics.record("$side ${event.describe()}")
        scope.launch {
            when (event.type) {
                G1EventType.CLOSE_ACTIVE -> { mutable.update { it.copy(page = 0, dismissed = true).pendingDisplay() } }
                G1EventType.SILENT_ON -> { mutable.update { it.copy(silent = true).pendingDisplay() } }
                G1EventType.SILENT_OFF -> { mutable.update { it.copy(silent = false).pendingDisplay() }; if (!mutable.value.dismissed) requests.trySend(Unit) }
                else -> Unit
            }
        }
    }
    private fun setArm(side: Side, value: String) { mutable.update { if (side == Side.L) it.copy(left = value) else it.copy(right = value) } }
    private fun releaseArms() { arms.values.forEach { it.close() }; arms.clear(); devices.clear() }
    suspend fun stop() {
        session?.cancelAndJoin(); session = null
        renderer?.cancelAndJoin(); renderer = null
        try {
            for (arm in arms.values.filter { it.ready }) try { arm.request(G1Protocol.exit(), 1500) } catch (_: IOException) { G1Diagnostics.record("Stop: exit not acknowledged") }
        } catch (_: SecurityException) { G1Diagnostics.record("Stop after permission revocation") }
        finally { releaseArms(); pages = emptyList(); mutable.value = mutable.value.stopped() }
    }
    private suspend fun discoverPair(): Map<Side, BluetoothDevice> {
        val adapter = context.getSystemService(BluetoothManager::class.java).adapter ?: throw IOException("Bluetooth unavailable")
        if (!adapter.isEnabled) throw IOException("Bluetooth is off. Turn it on and tap Connect again.")
        val scanner = adapter.bluetoothLeScanner ?: throw IOException("BLE scanner unavailable")
        val catalog = G1Discovery()
        val scanned = mutableMapOf<String, BluetoothDevice>()
        val failed = CompletableDeferred<Unit>()
        var scanning = true
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (!scanning) return
                val device = result.device
                if (!catalog.observe(result.scanRecord?.deviceName ?: device.name, device.address)) return
                scanned[device.address] = device
                mutable.update { it.copy(session = "Scanning for G1 pairs (20 seconds)… ${catalog.armCount} arms found") }
            }
            override fun onScanFailed(errorCode: Int) {
                if (scanning) failed.completeExceptionally(IOException("BLE scan failed ($errorCode). Tap Connect to try again."))
            }
        }
        try {
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
            // Observe the full bounded window instead of silently choosing the first pair in a room.
            withTimeoutOrNull(20_000) { failed.await() }
        } finally {
            scanning = false
            scanner.stopScan(callback)
        }
        discovery = catalog
        return try {
            val selected = catalog.select { choices ->
                mutable.update { it.copy(pairs = choices, session = if (choices.isEmpty()) it.session else "Choose your G1 pair") }
            }
            G1Diagnostics.record("G1 pair selected")
            selected.mapValues { (_, address) -> scanned.getValue(address) }
        } finally { discovery = null }
    }
}
