// Wire format of the Even Realities G1, as published in Even Realities'
// EvenDemoApp (BSD 2-Clause, see THIRD_PARTY_NOTICES.md): README "Instructions",
// lib/services/proto.dart, lib/services/evenai_proto.dart and
// android/.../bluetooth/BleManager.kt. Pure functions only, so the byte layouts
// are unit-tested on the JVM.

package dev.pidash.g1

import java.util.UUID

enum class Side { L, R }

/** One temple ("arm") as it advertises itself, e.g. `G1_45_L_92333`. */
data class ArmName(val channel: String, val side: Side)

/**
 * 0xF5 pushes with a known meaning. EvenDemoApp documents 0x00, 0x01, 0x17 and 0x18; the rest come from
 * the BSD-licensed even-g1-companion protocol notes (firmware 1.6.6 captures), and every code seen in
 * the source PoC's first device log is listed. There is deliberately no single-tap entry: the firmware
 * handles single taps itself and never reports them (no 0xF5 0x01 in either the community captures
 * or the source PoC's logs).
 */
enum class G1EventType(val code: Int, val label: String) {
    CLOSE_ACTIVE(0x00, "glasses closed the active screen (double tap, or Silent Mode turning on)"),
    HEAD_UP(0x02, "head tilted up"),
    HEAD_DOWN(0x03, "head back down"),
    SILENT_ON(0x04, "Silent Mode ON (triple tap)"),
    SILENT_OFF(0x05, "Silent Mode OFF (triple tap)"),
    WORN(0x06, "worn"),
    TRANSITIONING(0x07, "being put on or taken off"),
    IN_CASE_LID_OPEN(0x08, "in case, lid open"),
    BATTERY(0x0A, "battery"),
    IN_CASE_LID_CLOSED(0x0B, "in case, lid closed"),
    BRIGHTNESS(0x12, "brightness"),
    LEFT_LONG_PRESS(0x17, "left long press started (Even AI)"),
    LEFT_LONG_PRESS_RELEASED(0x18, "left long press released"),
    DOUBLE_TAP_OPENED(0x20, "double tap opened a feature"),
}

/** A decoded 0xF5 push; [value] is byte 2, meaningful for battery (percent) and brightness. */
data class G1Event(val code: Int, val value: Int) {
    val type: G1EventType? = G1EventType.entries.firstOrNull { it.code == code }

    fun describe(): String {
        val meaning = when (type) {
            null -> "unknown event"
            G1EventType.BATTERY -> "battery $value%"
            G1EventType.BRIGHTNESS -> "brightness $value"
            else -> type.label
        }
        return "f5 %02x %s".format(code, meaning)
    }
}

object G1Protocol {
    val SERVICE: UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    val WRITE_CHARACTERISTIC: UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    val NOTIFY_CHARACTERISTIC: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    val CLIENT_CONFIG_DESCRIPTOR: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val MTU = 251

    const val CMD_TEXT = 0x4E
    const val CMD_HEARTBEAT = 0x25
    const val CMD_EXIT = 0x18
    const val CMD_EVENT = 0xF5
    const val CMD_MIC_AUDIO = 0xF1
    /** Sent unprompted by the right arm after a right long press records a QuickNote on the glasses. */
    const val CMD_QUICKNOTE_LIST = 0x21

    private const val STATUS_OK = 0xC9
    private const val STATUS_CONTINUE = 0xCB

    /** Payload bytes per 0x4E packet (evenaiMultiPackListV2 `len`). */
    const val TEXT_CHUNK_BYTES = 191

    /** 0x01 "display new content" | 0x70 "text show" (README "Text Sending"). */
    const val SCREEN_NEW_TEXT = 0x71

    /** Sent to each arm once it is set up (BleManager.kt onServicesDiscovered). */
    fun connectedHello(): ByteArray = bytes(0xF4, 0x01)

    /** Proto.sendHeartBeat; the demo wraps the sequence with `% 0xff`, kept as-is. */
    fun heartbeat(seq: Int): ByteArray {
        val length = 6
        val s = seq % 0xff
        return bytes(CMD_HEARTBEAT, length and 0xff, (length shr 8) and 0xff, s, 0x04, s)
    }

    fun isHeartbeatAck(response: ByteArray): Boolean =
        response.size > 5 && response.u(0) == CMD_HEARTBEAT && response.u(4) == 0x04

    /** Proto.exit: leave the current feature and return the glasses to the dashboard. */
    fun exit(): ByteArray = bytes(CMD_EXIT)

    /** Acknowledgement used by _requestList and Proto.exit: byte 1 is 0xC9 (or 0xCB for a continued text packet). */
    fun isAck(response: ByteArray): Boolean =
        response.size > 1 && (response.u(1) == STATUS_OK || response.u(1) == STATUS_CONTINUE)

    /**
     * Whether [response] answers [request]. A text completion `4e c9 <seq> …` echoes the request's
     * sequence byte, and the right arm can deliver it minutes late (it holds it while Silent Mode is
     * on), so it must match that byte or a stale completion would confirm a newer page. Everything
     * Heartbeats match their sequence too. Other replies, including the not-yet-observed
     * `4e cb` for a continued packet, match on the command byte as in the demo.
     */
    fun answers(request: ByteArray, response: ByteArray): Boolean {
        if (request.isEmpty() || response.isEmpty() || request[0] != response[0]) return false
        if (request.u(0) == CMD_HEARTBEAT) return response.size > 5 && request.size > 3 && response[3] == request[3] && isHeartbeatAck(response)
        val textCompletion = request.u(0) == CMD_TEXT && response.size > 1 && response.u(1) == STATUS_OK
        return !textCompletion || (request.size > 1 && response.size > 2 && response[2] == request[1])
    }

    /**
     * One screen of text as 0x4E packets (evenaiMultiPackListV2):
     * `[0x4E, syncSeq, packetCount, packetIndex, newScreen, pos(2, big endian), page, pageCount] + payload`.
     * [page] is 1-based like TextService.getCurrentPage.
     */
    fun textPackets(text: String, syncSeq: Int, page: Int, pageCount: Int, pos: Int = 0): List<ByteArray> {
        val data = text.toByteArray(Charsets.UTF_8)
        require(data.isNotEmpty()) { "text must not be empty" }
        require(page in 1..pageCount && pageCount <= 255) { "page $page of $pageCount out of range" }
        val chunks = (data.size + TEXT_CHUNK_BYTES - 1) / TEXT_CHUNK_BYTES
        require(chunks <= 255) { "text too long for one screen: ${data.size} bytes" }
        return (0 until chunks).map { index ->
            val payload = data.copyOfRange(index * TEXT_CHUNK_BYTES, minOf(data.size, (index + 1) * TEXT_CHUNK_BYTES))
            bytes(
                CMD_TEXT,
                syncSeq and 0xff,
                chunks,
                index,
                SCREEN_NEW_TEXT,
                (pos shr 8) and 0xff,
                pos and 0xff,
                page,
                pageCount,
            ) + payload
        }
    }

    /** BleManager.kt scan filter: `G<n>_<channel>_<L|R>_<serial>`, exactly four parts. */
    fun parseArmName(name: String?): ArmName? {
        val parts = name?.split("_") ?: return null
        if (parts.size != 4 || !Regex("(?:^| )G1$").containsMatchIn(parts[0])) return null
        val side = when (parts[2]) {
            "L" -> Side.L
            "R" -> Side.R
            else -> return null
        }
        return ArmName(parts[1], side)
    }

    /** An 0xF5 push (`f5 <code> <value> …`, padded to 21 bytes by the firmware), or null for anything else. */
    fun decodeEvent(frame: ByteArray): G1Event? {
        if (frame.size < 2 || frame.u(0) != CMD_EVENT) return null
        return G1Event(frame.u(1), if (frame.size > 2) frame.u(2) else 0)
    }

    /**
     * Number of QuickNotes stored on the glasses, from the 0x21 list: `21 <frame length> 00 <seq> 01
     * <count>` followed by `count` entries of a slot byte and an 8-byte note id. Layout inferred from
     * the three frames in the first device log (counts 1, 2, 3) and the community notes' 15-byte
     * single-note frame; null when a frame does not fit it.
     */
    fun quickNoteCount(frame: ByteArray): Int? {
        if (frame.size < 6 || frame.u(0) != CMD_QUICKNOTE_LIST || frame.u(1) != frame.size) return null
        val count = frame.u(5)
        return count.takeIf { frame.size == 6 + 9 * count }
    }

    fun hex(data: ByteArray, max: Int = 32): String {
        val shown = data.take(max).joinToString(" ") { "%02x".format(it.toInt() and 0xff) }
        return if (data.size > max) "$shown … (${data.size} bytes)" else shown
    }

    private fun ByteArray.u(index: Int): Int = this[index].toInt() and 0xff

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
