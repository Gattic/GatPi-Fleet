package dev.pidash.g1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests built from frames in the first device log (shared-log.txt, 2026-10-06,
 * Android phone + G1 pair). 0xF5 frames arrive padded to 21 bytes.
 */
class G1EventDecodingTest {
    private fun frame(hex: String, padTo: Int = 0): ByteArray {
        val bytes = hex.split(" ").map { it.toInt(16).toByte() }
        return ByteArray(maxOf(padTo, bytes.size)) { bytes.getOrElse(it) { 0 } }
    }

    private fun event(hex: String) = G1Protocol.decodeEvent(frame(hex, padTo = 21))!!

    @Test
    fun decodesTheSilentModeEpisode() {
        // 01:30:24.855 L f5 04, then f5 00 from R, L, R: a triple tap turning Silent Mode on.
        assertEquals(G1EventType.SILENT_ON, event("f5 04").type)
        assertEquals(G1EventType.CLOSE_ACTIVE, event("f5 00").type)
        // 01:35:21.952 L f5 05: the triple tap that turned it off.
        assertEquals(G1EventType.SILENT_OFF, event("f5 05").type)
    }

    @Test
    fun closeActiveIsNotDescribedAsADoubleTapExit() {
        // It was logged as "double tap (demo: exit all)" although Silent Mode also sends it.
        val description = event("f5 00").describe()
        assertTrue(description, description.contains("closed the active screen"))
        assertFalse(description, description.contains("exit all"))
    }

    @Test
    fun describesCodesInHexLikeTheRawFrame() {
        // "f5 11" was described as "unhandled event 17".
        val unknown = event("f5 11")
        assertNull(unknown.type)
        assertEquals("f5 11 unknown event", unknown.describe())
        assertEquals("f5 04 Silent Mode ON (triple tap)", event("f5 04").describe())
    }

    @Test
    fun decodesEveryCodeSeenInTheLog() {
        assertEquals(G1EventType.HEAD_UP, event("f5 02").type)
        assertEquals(G1EventType.HEAD_DOWN, event("f5 03").type)
        assertEquals(G1EventType.WORN, event("f5 06").type)
        assertEquals(G1EventType.TRANSITIONING, event("f5 07").type)
        assertNull(event("f5 09").type) // not mapped with confidence in the community notes
        assertEquals("f5 0a battery 100%", event("f5 0a 64").describe())
        assertEquals("f5 0a battery 99%", event("f5 0a 63").describe())
        assertEquals("f5 12 brightness 12", event("f5 12 0c").describe())
    }

    @Test
    fun onlyF5FramesAreEvents() {
        assertNull(G1Protocol.decodeEvent(frame("4e c9 16 01 00", padTo = 21)))
        assertNull(G1Protocol.decodeEvent(frame("f5")))
    }

    @Test
    fun countsQuickNotesFromTheRightArmList() {
        // 01:35:43 and 01:36:01: right long presses that recorded the first and second QuickNote.
        assertEquals(1, G1Protocol.quickNoteCount(frame("21 0f 00 00 01 01 01 a0 02 92 65 7f 2c de 42")))
        val second = frame("21 18 00 01 01 02 01 a0 02 92 65 7f 2c de 42 02 b2 02 92 65 03 64 1e bd")
        assertEquals(2, G1Protocol.quickNoteCount(second))
        assertNull(G1Protocol.quickNoteCount(second.copyOf(second.size - 1)))
        assertNull(G1Protocol.decodeEvent(second))
    }

    @Test
    fun lateTextCompletionDoesNotConfirmANewerPage() {
        // 01:35:22 R "4e c9 16 …" completed the seq 0x16 page sent at 01:31:41, held back during Silent Mode.
        val late = frame("4e c9 16 01 00", padTo = 21)
        val page = G1Protocol.textPackets("01 G1 PoC paging test\n", syncSeq = 0x16, page = 1, pageCount = 3).single()
        val newerPage = G1Protocol.textPackets("01 G1 PoC paging test\n", syncSeq = 0x17, page = 1, pageCount = 3).single()
        assertTrue(G1Protocol.answers(page, late))
        assertFalse(G1Protocol.answers(newerPage, late))
        // The sequence byte wraps like the request header: seq 0x116 is sent and echoed as 0x16.
        val wrapped = G1Protocol.textPackets("x", syncSeq = 0x116, page = 1, pageCount = 1).single()
        assertTrue(G1Protocol.answers(wrapped, late))
    }

    @Test
    fun otherAnswersMatchOnTheCommandByte() {
        // Inline left-arm completion from 01:30:40 for seq 0x0b.
        val page = G1Protocol.textPackets("x", syncSeq = 0x0b, page = 1, pageCount = 1).single()
        assertTrue(G1Protocol.answers(page, frame("4e c9 0b 01 00", padTo = 21)))
        assertTrue(G1Protocol.answers(page, frame("4e cb")))
        assertTrue(G1Protocol.answers(G1Protocol.exit(), frame("18 c9", padTo = 20)))
        assertTrue(G1Protocol.answers(G1Protocol.heartbeat(3), frame("25 06 00 03 04 03")))
        assertFalse(G1Protocol.answers(G1Protocol.heartbeat(3), frame("4e c9 03 01 00")))
    }
}
