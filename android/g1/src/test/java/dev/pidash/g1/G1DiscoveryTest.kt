package dev.pidash.g1

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class G1DiscoveryTest {
    private fun pair(discovery: G1Discovery, channel: String) {
        discovery.observe("G1_${channel}_L_test", "$channel-left")
        discovery.observe("G1_${channel}_R_test", "$channel-right")
    }

    @Test fun oneCompletePairIsSelectedWithoutAsking() = runBlocking {
        val discovery = G1Discovery()
        pair(discovery, "38")
        discovery.observe("G1_38_L_test", "38-left")
        discovery.observe("G1_45_L_other", "45-left")
        val selected = discovery.select { fail("A single complete pair must not prompt") }
        assertEquals(mapOf(Side.L to "38-left", Side.R to "38-right"), selected)
        assertEquals(3, discovery.armCount)
        assertFalse(discovery.choose("38"))
    }

    @Test fun armsFromDifferentChannelsNeverFormAPair() {
        val discovery = G1Discovery()
        discovery.observe("G1_38_L_test", "left")
        discovery.observe("G1_45_R_test", "right")
        val error = assertThrows(IOException::class.java) { runBlocking { discovery.select {} } }
        assertTrue(error.message!!.startsWith("No complete G1 pair found"))
    }

    @Test fun nonG1AndMalformedAdvertisementsAreIgnored() {
        val discovery = G1Discovery()
        assertFalse(discovery.observe("G2_38_L_test", "g2-left"))
        assertFalse(discovery.observe("G2_38_R_test", "g2-right"))
        assertFalse(discovery.observe("G1_38_X_test", "unknown-side"))
        assertFalse(discovery.observe(null, "unnamed"))
        assertEquals(0, discovery.armCount)
        assertThrows(IOException::class.java) { runBlocking { discovery.select {} } }
    }

    @Test fun multiplePairsWaitForAValidExplicitChoice() = runBlocking {
        val discovery = G1Discovery()
        pair(discovery, "45"); pair(discovery, "38")
        var choices = emptyList<String>()
        val selected = async(start = CoroutineStart.UNDISPATCHED) { discovery.select { choices = it } }
        assertEquals(listOf("38", "45"), choices)
        assertFalse(selected.isCompleted)
        assertFalse(discovery.choose("99"))
        assertFalse(selected.isCompleted)
        assertTrue(discovery.choose("45"))
        assertEquals(mapOf(Side.L to "45-left", Side.R to "45-right"), selected.await())
        assertTrue(choices.isEmpty())
        assertFalse(discovery.choose("38"))
    }

    @Test fun cancellingSelectionClearsChoicesAndRejectsLateClicks() = runBlocking {
        val discovery = G1Discovery()
        pair(discovery, "38"); pair(discovery, "45")
        var choices = emptyList<String>()
        val selected = async(start = CoroutineStart.UNDISPATCHED) { discovery.select { choices = it } }
        assertEquals(2, choices.size)
        selected.cancelAndJoin()
        assertTrue(choices.isEmpty())
        assertFalse(discovery.choose("38"))
    }

    @Test fun conflictingArmsAreRejectedWithoutDisclosingIdentifiers() {
        val discovery = G1Discovery()
        pair(discovery, "38")
        discovery.observe("G1_38_L_private", "private-second-left")
        val error = assertThrows(IOException::class.java) { runBlocking { discovery.select {} } }
        assertTrue(error.message!!.startsWith("Conflicting G1 arms found"))
        assertFalse(error.message!!.contains("private"))
        assertFalse(error.message!!.contains("38-left"))
    }

    @Test fun oneDeviceCannotRepresentBothTemples() {
        val discovery = G1Discovery()
        discovery.observe("G1_38_L_test", "same-device")
        discovery.observe("G1_38_R_test", "same-device")
        assertThrows(IOException::class.java) { runBlocking { discovery.select {} } }
    }

    @Test fun cleanupRetainsFailureButClearsConnectionAndSelectionState() {
        val stopped = GlassesState(session = "recovering", left = "ready", right = "lost", displayStatus = DisplayStatus.ACKNOWLEDGED,
            page = 1, pageCount = 3, pairs = listOf("38", "45"), error = "Bluetooth permission revoked").stopped()
        assertEquals("Bluetooth permission revoked", stopped.error)
        assertEquals("stopped", stopped.session)
        assertEquals("-", stopped.left)
        assertEquals("-", stopped.right)
        assertEquals(DisplayStatus.IDLE, stopped.displayStatus)
        assertEquals(0, stopped.pageCount)
        assertTrue(stopped.pairs.isEmpty())
    }
}
