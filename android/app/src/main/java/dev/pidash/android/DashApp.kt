package dev.pidash.android

import android.app.Application
import android.content.Context
import dev.pidash.g1.G1Glasses
import dev.pidash.g1.GlassesState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow

data class WearSelection(val id: String? = null, val excerpt: String? = null, val version: Int = 0)

class DashApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var vault: Vault
        private set
    lateinit var repository: GatewayRepository
        private set
    val glassesState = MutableStateFlow(GlassesState())
    val monitoring = MutableStateFlow(false)
    val wearSelection = MutableStateFlow(WearSelection())
    val attentionAlerts = MutableStateFlow(false)
    var glasses: G1Glasses? = null
    override fun onCreate() {
        super.onCreate()
        vault = Vault(this)
        repository = GatewayRepository(scope, vault)
        val prefs = getSharedPreferences("display", Context.MODE_PRIVATE)
        prefs.edit().remove("channel").apply()
        attentionAlerts.value = prefs.getBoolean("attention", false)
        wearSelection.value = WearSelection(prefs.getString("pin", null))
    }
    fun display(id: String? = null, excerpt: String? = null) {
        wearSelection.value = WearSelection(id, excerpt, wearSelection.value.version + 1)
        getSharedPreferences("display", Context.MODE_PRIVATE).edit().putString("pin", id).apply()
    }
    fun alerts(enabled: Boolean) {
        attentionAlerts.value = enabled
        getSharedPreferences("display", Context.MODE_PRIVATE).edit().putBoolean("attention", enabled).apply()
    }
}
