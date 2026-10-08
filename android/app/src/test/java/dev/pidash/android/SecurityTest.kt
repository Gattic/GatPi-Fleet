package dev.pidash.android

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.Collections
import kotlin.concurrent.thread

class SecurityTest {
    private fun document(cert: HeldCertificate, url: String) = JSONObject().put("version", 1).put("url", url.trimEnd('/'))
        .put("token", "a".repeat(43)).put("caCertificate", cert.certificatePem())
        .put("fingerprint", MessageDigest.getInstance("SHA-256").digest(cert.certificate.encoded).joinToString(":") { "%02X".format(it) }).toString()
    @Test fun rejectsCleartextCredentialsInUrlsAndMismatchedFingerprint() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(document(cert, "http://localhost:1234")) }
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(document(cert, "https://user:secret@localhost:1234")) }
        val wrong = JSONObject(document(cert, "https://localhost:1234")).put("fingerprint", "wrong").toString()
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(wrong) }
    }
    @Test fun trustsOnlyTheProvisionedCertificateAndKeepsHostnameVerification() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
            server.start()
            val pair = Pairing.parse(document(cert, server.url("/").toString()))
            val client = pair.client()
            server.enqueue(MockResponse().setBody("{\"version\":1}"))
            assertEquals(1, runBlocking { gatewayJson(client, pair, "/api/v1/info") }.getInt("version"))
            assertEquals("Bearer " + "a".repeat(43), server.takeRequest().getHeader("Authorization"))
            val other = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
            val wrongTrust = Pairing.parse(document(other, server.url("/").toString()))
            val untrusted = wrongTrust.client()
            assertThrows(javax.net.ssl.SSLHandshakeException::class.java) { runBlocking { gatewayJson(untrusted, wrongTrust, "/api/v1/info") } }
            untrusted.connectionPool.evictAll(); untrusted.dispatcher.executorService.shutdown()
            val wrongHost = Pairing.parse(document(cert, "https://127.0.0.1:${server.port}"))
            assertThrows(javax.net.ssl.SSLPeerUnverifiedException::class.java) { runBlocking { gatewayJson(client, wrongHost, "/api/v1/info") } }
            client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }
    @Test fun requestsAfterTheGatewayClosedAnIdleConnectionReachItExactlyOnce() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val received = Collections.synchronizedList(mutableListOf<String>())
        // Like the gateway's keep-alive timeout: an idle connection is closed later, without telling the client.
        HandshakeCertificates.Builder().heldCertificate(cert).build().sslContext().serverSocketFactory.createServerSocket(0).use { listener ->
            thread(isDaemon = true) {
                while (true) {
                    val socket = try { listener.accept() } catch (_: IOException) { break }
                    thread(isDaemon = true) {
                        socket.use {
                            val input = socket.getInputStream().bufferedReader()
                            try {
                                while (true) {
                                    val head = generateSequence { input.readLine()?.takeIf { it.isNotEmpty() } }.toList()
                                    if (head.isEmpty()) return@use
                                    val length = head.firstNotNullOfOrNull { Regex("(?i)content-length: (\\d+)").find(it)?.groupValues?.get(1)?.toInt() } ?: 0
                                    input.read(CharArray(length), 0, length)
                                    received += head.first().substringBeforeLast(" ")
                                    val body = "{\"n\":${received.size}}"
                                    socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n$body".toByteArray()); flush() }
                                    socket.soTimeout = 200
                                }
                            } catch (_: SocketTimeoutException) {}
                        }
                    }
                }
            }
            val pair = Pairing.parse(document(cert, "https://localhost:${listener.localPort}"))
            val client = pair.client()
            assertEquals(1, runBlocking { gatewayJson(client, pair, "/api/v1/projects") }.getInt("n"))
            Thread.sleep(600)
            assertEquals(2, runBlocking { gatewayJson(client, pair, "/api/v1/projects") }.getInt("n"))
            Thread.sleep(600)
            // A command is never retried, so it must not be written to a connection the gateway has closed.
            assertEquals(3, runBlocking { gatewayJson(client, pair, "/api/v1/sessions", JSONObject().put("projectId", "p")) }.getInt("n"))
            assertEquals(listOf("GET /api/v1/projects", "GET /api/v1/projects", "POST /api/v1/sessions"), received.toList())
            client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }
    @Test fun mutationDoesNotFollowRedirectsOrRetryServerFailures() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
            server.start()
            val pair = Pairing.parse(document(cert, server.url("/").toString()))
            val client = pair.client()
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", server.url("/other")).setBody("{\"error\":\"redirect rejected\"}"))
            assertThrows(GatewayFailure::class.java) { runBlocking { gatewayJson(client, pair, "/command", JSONObject().put("kind", "abort")) } }
            assertEquals(1, server.requestCount)
            client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }
}
