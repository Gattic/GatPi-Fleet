package dev.pidash.android

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/** Keeps the drafts document between runs of the app. */
interface DraftStorage {
    fun read(): String?
    fun save(document: String)
}

/** The drafts document in the app's encrypted vault. */
class VaultDraftStorage(private val vault: Vault) : DraftStorage {
    override fun read() = vault.read("drafts")
    override fun save(document: String) = vault.save("drafts", document)
}

/**
 * The prompt being written for the [selected] session, and the unsent drafts of the last three sessions.
 * Earlier prompts stepped through with [older] and [newer] are only shown: the saved draft stays the one
 * typed before, until a shown prompt is edited or sent.
 */
class Drafts(private val storage: DraftStorage, private val selected: () -> String?) {
    private val mutableText = MutableStateFlow("")
    val text: StateFlow<String> = mutableText
    private val mutableRecall = MutableStateFlow(PromptRecall())
    /** Where the shown text is in the selected session's earlier prompts. */
    val recall: StateFlow<PromptRecall> = mutableRecall
    private val saved = linkedMapOf<String, String>()

    /** Reads the drafts an earlier run saved. */
    fun restore() {
        val document = storage.read() ?: return
        val json = JSONObject(document)
        json.keys().forEach { saved[it] = json.getString(it).take(MAX_LENGTH) }
    }

    /** Shows the selected session's saved draft. */
    fun open() {
        mutableRecall.value = PromptRecall()
        mutableText.value = selected()?.let(saved::get).orEmpty()
    }

    /** Typed or chosen text becomes the draft and ends browsing, as in pi: the next older prompt starts again from the newest. */
    fun edit(value: String) {
        mutableRecall.value = PromptRecall()
        keep(value)
    }

    /** Sent text stays as the draft: a shown earlier prompt becomes it; a typed draft is already saved. */
    fun sent() { if (recall.value.position != null) edit(text.value) }

    fun older(prompts: List<String>) { recall.value.older(prompts, text.value)?.let(::show) }
    fun newer(prompts: List<String>) { recall.value.newer(prompts)?.let(::show) }

    /** Forgets every draft. Their storage is erased with the pairing, not here. */
    fun clear() {
        saved.clear()
        mutableRecall.value = PromptRecall()
        mutableText.value = ""
    }

    private fun show(step: Pair<PromptRecall, String>) {
        mutableRecall.value = step.first
        mutableText.value = step.second
    }

    private fun keep(value: String) {
        mutableText.value = value.take(MAX_LENGTH)
        val id = selected() ?: return
        saved.remove(id); saved[id] = mutableText.value
        while (saved.size > 3) saved.remove(saved.keys.first())
        storage.save(JSONObject(saved.toMap()).toString())
    }

    private companion object {
        /** The longest prompt the gateway accepts. */
        const val MAX_LENGTH = 32_000
    }
}
