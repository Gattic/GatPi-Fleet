package dev.pidash.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// Never a data class: generated toString() must not print credentials.
class Pairing(val url: String, val token: String, val ca: String, val fingerprint: String) {
    companion object {
        fun parse(text: String): Pairing {
            require(text.length <= 16_000) { "Pairing document too large" }
            val j = JSONObject(text)
            require(j.getInt("version") == 1) { "Unsupported pairing version" }
            val url = j.getString("url").toHttpUrl()
            require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null) { "Pairing URL must be an HTTPS origin" }
            val token = j.getString("token")
            require(Regex("[A-Za-z0-9_-]{43}").matches(token)) { "Invalid device token" }
            val ca = j.getString("caCertificate")
            val cert = certificate(ca)
            cert.checkValidity()
            val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }
            require(fingerprint.equals(j.getString("fingerprint"), ignoreCase = true)) { "Certificate fingerprint mismatch" }
            return Pairing(url.toString().trimEnd('/'), token, ca, fingerprint)
        }
        fun certificate(pem: String): X509Certificate = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
    }
    fun client(): OkHttpClient {
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("host", certificate(ca)) }
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        val trust = factory.trustManagers.single() as X509TrustManager
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
            // OkHttp's normal hostname verifier remains enabled. No trust-all, redirects or side-effect retries.
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()
    }
}

/** Private, backup-excluded storage. Credentials and drafts use an Android Keystore AES key. */
class Vault(context: Context) {
    private val prefs = context.getSharedPreferences("vault", Context.MODE_PRIVATE)
    private val alias = "pi-dash-storage"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(name: String): String? {
        val encoded = prefs.getString(name, null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 12) { "Encrypted preferences are damaged; re-pair this device" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(name.toByteArray())
        return cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
    }
    @Synchronized fun save(name: String, value: String?) {
        if (value == null) { check(prefs.edit().remove(name).commit()) { "Unable to erase local state" }; return }
        // Three 32k drafts may expand sixfold when JSON-escaped.
        require(value.length <= 600_000) { "Local storage item too large" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(name.toByteArray())
        val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        check(prefs.edit().putString(name, encoded).commit()) { "Unable to save local settings" }
    }
    @Synchronized fun clear() { check(prefs.edit().clear().commit()) }
}
