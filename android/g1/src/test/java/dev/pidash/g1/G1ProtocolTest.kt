package dev.pidash.g1

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class G1ProtocolTest {
    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    @Test
    fun heartbeatMatchesTheDemoLayout() {
        assertArrayEquals(bytes(0x25, 0x06, 0x00, 0x00, 0x04, 0x00), G1Protocol.heartbeat(0))
        assertArrayEquals(bytes(0x25, 0x06, 0x00, 0x07, 0x04, 0x07), G1Protocol.heartbeat(7))
        // Proto.sendHeartBeat wraps with `% 0xff`, so 255 becomes 0 and 256 becomes 1.
        assertArrayEquals(bytes(0x25, 0x06, 0x00, 0x00, 0x04, 0x00), G1Protocol.heartbeat(255))
        assertArrayEquals(bytes(0x25, 0x06, 0x00, 0x01, 0x04, 0x01), G1Protocol.heartbeat(256))
    }

    @Test
    fun recognisesHeartbeatAnswers() {
        assertTrue(G1Protocol.isHeartbeatAck(bytes(0x25, 0x06, 0x00, 0x03, 0x04, 0x03)))
        assertFalse(G1Protocol.isHeartbeatAck(bytes(0x25, 0x06, 0x00, 0x03, 0x05, 0x03)))
        assertFalse(G1Protocol.isHeartbeatAck(bytes(0x25, 0x06, 0x00, 0x03, 0x04)))
        assertFalse(G1Protocol.isHeartbeatAck(bytes(0x4E, 0x06, 0x00, 0x03, 0x04, 0x03)))
    }

    @Test
    fun rejectsStaleHeartbeatSequences() {
        val request = G1Protocol.heartbeat(7)
        assertTrue(G1Protocol.answers(request, bytes(0x25, 6, 0, 7, 4, 7)))
        assertFalse(G1Protocol.answers(request, bytes(0x25, 6, 0, 6, 4, 6)))
    }

    @Test
    fun recognisesAcknowledgements() {
        assertTrue(G1Protocol.isAck(bytes(0x4E, 0xC9)))
        assertTrue(G1Protocol.isAck(bytes(0x4E, 0xCB)))
        assertFalse(G1Protocol.isAck(bytes(0x4E, 0xCA)))
        assertFalse(G1Protocol.isAck(bytes(0x4E)))
    }

    @Test
    fun splitsTextIntoHeaderedPackets() {
        val text = "x".repeat(400)
        val packets = G1Protocol.textPackets(text, syncSeq = 300, page = 2, pageCount = 3)

        assertEquals(3, packets.size)
        packets.forEachIndexed { index, packet ->
            // [cmd, syncSeq & 0xff, packet count, packet index, newScreen, pos hi, pos lo, page, page count]
            assertArrayEquals(bytes(0x4E, 300 and 0xff, 3, index, 0x71, 0, 0, 2, 3), packet.copyOfRange(0, 9))
        }
        assertEquals(listOf(191, 191, 18), packets.map { it.size - 9 })
        val payload = packets.fold(ByteArray(0)) { all, packet -> all + packet.copyOfRange(9, packet.size) }
        assertArrayEquals(text.toByteArray(), payload)
    }

    @Test
    fun keepsUtf8BytesIntactAcrossPackets() {
        val text = "é".repeat(150) // 300 bytes, so one character straddles the 191-byte boundary
        val packets = G1Protocol.textPackets(text, syncSeq = 0, page = 1, pageCount = 1)
        val payload = packets.fold(ByteArray(0)) { all, packet -> all + packet.copyOfRange(9, packet.size) }
        assertEquals(text, payload.toString(Charsets.UTF_8))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsEmptyText() {
        G1Protocol.textPackets("", syncSeq = 0, page = 1, pageCount = 1)
    }

    @Test
    fun parsesArmNamesLikeTheDemoScanner() {
        assertEquals(ArmName("45", Side.L), G1Protocol.parseArmName("G1_45_L_92333"))
        assertEquals(ArmName("74", Side.R), G1Protocol.parseArmName("Even G1_74_R_57D3D1"))
        assertNull(G1Protocol.parseArmName("G1_45_X_92333"))
        assertNull(G1Protocol.parseArmName("G1_45_L"))
        assertNull(G1Protocol.parseArmName("Pixel Buds"))
        assertNull(G1Protocol.parseArmName(null))
    }
}
