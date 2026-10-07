package dev.pidash.g1

import kotlinx.coroutines.CompletableDeferred
import java.io.IOException
import java.util.EnumMap

/** A scan's G1 arms, grouped without mixing pairs or exposing device addresses in UI state. */
class G1Discovery {
    private val pairs = mutableMapOf<String, EnumMap<Side, String>>()
    private var conflicting = false
    private var selection: CompletableDeferred<String>? = null
    private var choices: List<String> = emptyList()
    val armCount: Int get() = pairs.values.sumOf { it.size }

    fun observe(name: String?, address: String): Boolean {
        val arm = G1Protocol.parseArmName(name) ?: return false
        val pair = pairs.getOrPut(arm.channel) { EnumMap(Side::class.java) }
        val previous = pair.putIfAbsent(arm.side, address)
        if (previous != null && previous != address) conflicting = true
        if (pair.size == 2 && pair[Side.L] == pair[Side.R]) conflicting = true
        return true
    }

    /** Called after scanning stops, so a later advertisement cannot change a displayed choice. */
    suspend fun select(onChoices: (List<String>) -> Unit): Map<Side, String> {
        check(selection == null) { "Pair selection already pending" }
        if (conflicting) throw IOException("Conflicting G1 arms found. Keep only your pair available and tap Connect again.")
        val complete = pairs.filterValues { it.size == Side.entries.size }
        if (complete.isEmpty()) throw IOException("No complete G1 pair found. Wear the glasses and release them from the other controller, then tap Connect again.")
        if (complete.size == 1) return complete.values.single().toMap()
        val answer = CompletableDeferred<String>()
        selection = answer
        choices = complete.keys.sorted()
        try {
            onChoices(choices)
            return complete.getValue(answer.await()).toMap()
        } finally {
            selection = null
            choices = emptyList()
            onChoices(emptyList())
        }
    }

    /** Unknown or late UI selections cannot connect a pair outside this scan. */
    fun choose(channel: String): Boolean = channel in choices && selection?.complete(channel) == true
}
