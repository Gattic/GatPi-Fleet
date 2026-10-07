// One temple ("arm") of the G1: its own BLE connection to the Nordic UART
// service. The setup order follows EvenDemoApp's BleManager.kt (discover
// services, enable notifications, MTU 251, bond). Unlike the demo, every GATT
// operation is awaited before the next one starts, because Android runs one
// GATT operation at a time and silently drops overlapping ones.

package dev.pidash.g1

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

// Bluetooth calls need BLUETOOTH_CONNECT, which MainActivity obtains before it
// starts GlassesService; nothing here runs before that.
@SuppressLint("MissingPermission")
class G1Arm(
    val side: Side,
    private val device: BluetoothDevice,
    private val context: Context,
    private val onEvent: (Side, ByteArray) -> Unit,
    private val onDisconnected: (Side) -> Unit,
) {
    @Volatile
    var ready = false
        private set

    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private var writeCharacteristic: BluetoothGattCharacteristic? = null
    @Volatile private var connection: CompletableDeferred<Unit>? = null
    @Volatile private var operation: CompletableDeferred<Int>? = null
    private val operationLock = Mutex()
    private class Pending(val request: ByteArray, val answer: CompletableDeferred<ByteArray>)

    /** Requests waiting for an answer, keyed by command byte like the demo's `_reqListen`. */
    private val responses = ConcurrentHashMap<Int, Pending>()
    private var micPackets = 0

    suspend fun connect() {
        close()
        log("connecting")
        val connected = CompletableDeferred<Unit>()
        connection = connected
        val newGatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, Handler(Looper.getMainLooper()))
            ?: throw IOException("connectGatt returned null")
        gatt = newGatt
        try {
            withTimeoutOrNull(CONNECT_TIMEOUT_MS) { connected.await() }
                ?: throw IOException("no connection within $CONNECT_TIMEOUT_MS ms")
            gattOperation("discover services") { newGatt.discoverServices() }
            val service = newGatt.getService(G1Protocol.SERVICE) ?: throw IOException("UART service not found")
            val notify = service.getCharacteristic(G1Protocol.NOTIFY_CHARACTERISTIC)
                ?: throw IOException("notify characteristic not found")
            writeCharacteristic = service.getCharacteristic(G1Protocol.WRITE_CHARACTERISTIC)
                ?: throw IOException("write characteristic not found")
            if (!newGatt.setCharacteristicNotification(notify, true)) throw IOException("setCharacteristicNotification failed")
            val config = notify.getDescriptor(G1Protocol.CLIENT_CONFIG_DESCRIPTOR)
                ?: throw IOException("notification descriptor not found")
            gattOperation("enable notifications") {
                writeDescriptor(newGatt, config, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            }
            gattOperation("request MTU ${G1Protocol.MTU}") { newGatt.requestMtu(G1Protocol.MTU) }
            if (device.bondState == BluetoothDevice.BOND_NONE) {
                log("not bonded; createBond() = ${device.createBond()}")
            } else {
                log("bond state ${bondStateName(device.bondState)}")
            }
            ready = true
            log("ready")
        } catch (error: Exception) {
            close()
            throw error
        }
    }

    /** Writes [data] and waits for the next notification with the same command byte, or null on timeout. */
    suspend fun request(data: ByteArray, timeoutMs: Long): ByteArray? {
        val command = data[0].toInt() and 0xff
        val pending = Pending(data, CompletableDeferred())
        responses.put(command, pending)?.answer?.completeExceptionally(IOException("superseded by a newer 0x%02x request".format(command)))
        try {
            write(data)
            return withTimeoutOrNull(timeoutMs) { pending.answer.await() }
        } finally {
            responses.remove(command, pending)
        }
    }

    fun close() {
        ready = false
        val error = IOException("$side arm closed")
        connection?.completeExceptionally(error)
        operation?.completeExceptionally(error)
        responses.values.forEach { it.answer.completeExceptionally(error) }
        val oldGatt = gatt
        gatt = null
        try { oldGatt?.disconnect() }
        catch (_: SecurityException) { log("disconnect after permission revocation") }
        finally {
            try { oldGatt?.close() }
            catch (_: SecurityException) { log("close after permission revocation") }
        }
        writeCharacteristic = null
    }

    private suspend fun write(data: ByteArray) {
        val target = gatt
        val characteristic = writeCharacteristic
        if (!ready || target == null || characteristic == null) throw IOException("$side arm not connected")
        if (!isQuiet(data)) log("TX command ${data[0].toInt() and 0xff}, ${data.size} bytes")
        // WRITE_TYPE_NO_RESPONSE as in the demo's BleDevice.sendData; the glasses answer by notification.
        gattOperation("write") { writeCharacteristic(target, characteristic, data) }
    }

    private suspend fun gattOperation(name: String, start: () -> Boolean): Int = operationLock.withLock {
        val done = CompletableDeferred<Int>()
        operation = done
        try {
            if (!start()) throw IOException("$side $name could not start")
            val status = withTimeoutOrNull(OPERATION_TIMEOUT_MS) { done.await() }
                ?: throw IOException("$side $name: no callback within $OPERATION_TIMEOUT_MS ms")
            if (status != BluetoothGatt.GATT_SUCCESS) throw IOException("$side $name failed with status $status")
            status
        } catch (error: Exception) {
            // A timed-out/cancelled operation must not complete the next operation
            // through a late callback on the same GATT instance.
            close()
            throw error
        } finally { operation = null }
    }

    private fun received(value: ByteArray) {
        if (value.isEmpty()) return
        val command = value[0].toInt() and 0xff
        when (command) {
            G1Protocol.CMD_MIC_AUDIO -> if (++micPackets % 50 == 1) log("RX mic audio packet #$micPackets (not used)")
            G1Protocol.CMD_EVENT, G1Protocol.CMD_QUICKNOTE_LIST -> {
                log("RX event command $command")
                onEvent(side, value)
            }
            else -> {
                if (!isQuiet(value)) log("RX command $command, ${value.size} bytes")
                val pending = responses[command]
                when {
                    pending == null -> log("unsolicited 0x%02x".format(command))
                    !G1Protocol.answers(pending.request, value) ->
                        log("0x%02x answer is for an earlier request; still waiting".format(command))
                    responses.remove(command, pending) -> pending.answer.complete(value)
                }
            }
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(changed: BluetoothGatt, status: Int, newState: Int) {
            if (changed !== gatt) return
            log("connection state ${connectionStateName(newState)} (status $status)")
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> connection?.complete(Unit)
                BluetoothProfile.STATE_DISCONNECTED -> {
                    val wasReady = ready
                    ready = false
                    val error = IOException("$side arm disconnected (status $status)")
                    connection?.completeExceptionally(error)
                    operation?.completeExceptionally(error)
                    responses.values.forEach { it.answer.completeExceptionally(error) }
                    close()
                    if (wasReady) onDisconnected(side)
                }
            }
        }

        override fun onServicesDiscovered(changed: BluetoothGatt, status: Int) {
            if (changed === gatt) operation?.complete(status)
        }

        override fun onDescriptorWrite(changed: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (changed === gatt) operation?.complete(status)
        }

        override fun onMtuChanged(changed: BluetoothGatt, mtu: Int, status: Int) {
            if (changed !== gatt) return
            log("MTU $mtu (status $status)")
            operation?.complete(status)
        }

        override fun onCharacteristicWrite(changed: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (changed === gatt) operation?.complete(status)
        }

        override fun onCharacteristicChanged(changed: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (changed === gatt) received(value)
        }

        // Android 12 and older deliver notifications only through this overload.
        @Deprecated("Replaced by the ByteArray overload on Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(changed: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (changed === gatt) received(characteristic.value ?: return)
        }
    }

    private fun log(message: String) = G1Diagnostics.record("$side $message")

    /** Heartbeats are summarised by G1Glasses instead of logging every packet. */
    private fun isQuiet(data: ByteArray) = (data[0].toInt() and 0xff) == G1Protocol.CMD_HEARTBEAT

    companion object {
        private const val CONNECT_TIMEOUT_MS = 20_000L
        private const val OPERATION_TIMEOUT_MS = 5_000L

        private fun writeDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
            } else {
                legacyWriteDescriptor(gatt, descriptor, value)
            }

        private fun writeCharacteristic(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(characteristic, value, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                legacyWriteCharacteristic(gatt, characteristic, value)
            }

        @Suppress("DEPRECATION") // The only API before Android 13.
        private fun legacyWriteDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray): Boolean {
            descriptor.value = value
            return gatt.writeDescriptor(descriptor)
        }

        @Suppress("DEPRECATION") // The only API before Android 13.
        private fun legacyWriteCharacteristic(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray): Boolean {
            characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            characteristic.value = value
            return gatt.writeCharacteristic(characteristic)
        }

        private fun connectionStateName(state: Int) = when (state) {
            BluetoothProfile.STATE_CONNECTED -> "connected"
            BluetoothProfile.STATE_CONNECTING -> "connecting"
            BluetoothProfile.STATE_DISCONNECTING -> "disconnecting"
            BluetoothProfile.STATE_DISCONNECTED -> "disconnected"
            else -> "unknown $state"
        }

        private fun bondStateName(state: Int) = when (state) {
            BluetoothDevice.BOND_BONDED -> "bonded"
            BluetoothDevice.BOND_BONDING -> "bonding"
            else -> "none"
        }
    }
}
