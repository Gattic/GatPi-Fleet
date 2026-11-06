package dev.pidash.android

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * The real repository, OkHttp client and TLS, against local gateways standing in for the laptop's LAN address
 * (paired first) and its VPN address. Every connection must start with the LAN and fall back to the VPN.
 */
class GatewayRepositoryTest {
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("127.0.0.1").build()
    private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
    // Bind and request one literal address. After a dropped response OkHttp postpones that route;
    // "localhost" would then choose ::1, where this IPv4-only test server is not listening.
    private val localhost = InetAddress.getByName("127.0.0.1")
    private val snapshot = javaClass.classLoader!!.getResource("snapshot.json")!!.readText()
    // The app's main thread: the repository is used from one thread.
    private val main: ExecutorCoroutineDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val storage = MemoryStorage()
    private val closing = mutableListOf<AutoCloseable>()

    @After fun close() {
        closing.asReversed().forEach { it.close() }
        main.close()
    }

    @Test fun connectsThroughTheLanWhenBothAddressesAnswer() {
        val lan = Gateway(); val vpn = Gateway()
        val app = App(lan.url, vpn.url).open()
        waitFor(10.0, "online through the LAN") { app.onlineThrough(lan) }
        assertEquals("the VPN address was not tried", 0, vpn.server.requestCount)
    }

    @Test fun fallsBackToTheVpnThreeSecondsAfterAnUnansweredLan() {
        val lan = Unanswered(); val vpn = Gateway()
        val app = App(lan.url, vpn.url).open()
        val seconds = waitFor(15.0, "online through the VPN") { app.onlineThrough(vpn) }
        // With the client's normal 10 s connect timeout, the absent LAN would hold up the VPN that long.
        assertTrue("online through the VPN after $seconds s", seconds in 2.5..6.0)
    }

    @Test fun givesTheLastAddressTheFullConnectTimeout() {
        val lan = Unanswered(); val vpn = Unanswered()
        val app = App(lan.url, vpn.url).open()
        waitFor(6.0, "an attempt through the VPN") { app.origin() == vpn.url }
        Thread.sleep(4_500)
        // Nothing is left to fall back on: a slow VPN connection is not given up after 3 s.
        assertEquals("still connecting through the VPN", vpn.url, app.origin())
    }

    @Test fun fallsBackToTheVpnWhenTheLanStreamEnds() {
        val lan = Gateway(); val vpn = Gateway()
        val app = App(lan.url, vpn.url).open()
        waitFor(10.0, "online through the LAN") { app.onlineThrough(lan) }
        lan.close() // The phone leaves the LAN.
        waitFor(10.0, "online through the VPN") { app.onlineThrough(vpn) }
    }

    @Test fun returnsToTheLanWhenTheVpnStreamEnds() {
        val lanPort = freePort(); val vpn = Gateway()
        val app = App(originAt(lanPort), vpn.url).open()
        waitFor(10.0, "online through the VPN") { app.onlineThrough(vpn) }
        val lan = Gateway(lanPort) // The phone rejoins the LAN,
        vpn.endStreams() // and the VPN, still up, re-establishes.
        waitFor(10.0, "online through the LAN") { app.onlineThrough(lan) }
    }

    @Test fun reopeningTheAppStartsWithTheLan() {
        val lanPort = freePort(); val vpn = Gateway()
        val app = App(originAt(lanPort), vpn.url).open()
        waitFor(10.0, "online through the VPN") { app.onlineThrough(vpn) }
        app.leave()
        val lan = Gateway(lanPort)
        app.open()
        waitFor(10.0, "online through the LAN") { app.onlineThrough(lan) }
    }

    @Test fun restartingTheAppStartsWithTheLan() {
        val lanPort = freePort(); val vpn = Gateway()
        val first = App(originAt(lanPort), vpn.url).open()
        waitFor(10.0, "online through the VPN") { first.onlineThrough(vpn) }
        first.leave()
        val lan = Gateway(lanPort)
        // A new run reads the same storage: the address used last time is not where it starts.
        val second = App(storage).open()
        waitFor(10.0, "online through the LAN") { second.onlineThrough(lan) }
    }

    @Test fun pairingSkipsAnUnansweredLanAfterThreeSeconds() {
        val lan = Unanswered(); val vpn = Gateway()
        val app = App()
        val start = System.nanoTime()
        app.pair(pairingDocument(cert, lan.url, vpn.url))
        val seconds = (System.nanoTime() - start) / 1e9
        // Pairing away from the LAN is held up by it no longer than a connection is.
        assertTrue("paired after $seconds s", seconds in 2.5..6.0)
        assertEquals(listOf("GET /api/v1/info"), vpn.requests)
    }

    @Test fun requestsGoThroughTheAddressTheStreamUses() {
        val vpn = Gateway()
        val app = App(originAt(freePort()), vpn.url).open()
        waitFor(10.0, "online through the VPN") { app.onlineThrough(vpn) }
        // The LAN refuses connections: requests sent there instead fail.
        val project = app.projects().projects.single()
        app.launch(project)
        assertEquals(listOf("GET /api/v1/projects", "POST /api/v1/sessions"), vpn.requests.filter { it != "GET /api/v1/events" })
        assertNull("the launch receipt came back", app.pending())
    }

    @Test fun contextIncludesScopesAndEstimatedParts() {
        val gateway = Gateway().apply { context = javaClass.classLoader!!.getResource("context.json")!!.readText() }
        val app = App(gateway.url).open()
        waitFor(10.0, "online") { app.onlineThrough(gateway) }
        val report = app.context()
        assertEquals(ContextReport.SCOPES, report.scopes.map { it.scope })
        val open = report.scope("open")
        assertEquals("pi-dash", open.rows.first().label)
        assertEquals(18_000.0, open.rows.first().breakdown!!.unattributed!!, 0.0)
        assertNull(open.rows[2].tokens)
        assertEquals(206_000.0, open.cumulative.fillTokens, 0.0)
    }

    @Test fun usageIncludesRemoteHostsWhenTheGatewayReportsThem() {
        val gateway = Gateway().apply { usage = javaClass.classLoader!!.getResource("usage.json")!!.readText() }
        val app = App(gateway.url).open()
        waitFor(10.0, "online") { app.onlineThrough(gateway) }
        val report = app.usage()
        assertEquals(listOf("box00", "boxhome"), report.hosts.map { it.host })
        assertEquals(listOf<String?>(null, "box00", "boxhome"), report.range("30d").measure(Metric.Cost).hosts.map { it.host })
    }

    @Test fun anOlderGatewaysUsageIsRefusedWithTheInstructionToUpdateTheHost() {
        // The report a gateway sends before it counts remote hosts: neither the top-level nor the per-measure `hosts`.
        val older = JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText())
        older.remove("hosts")
        val ranges = older.getJSONArray("ranges")
        for (i in 0 until ranges.length()) for (measure in listOf("cost", "tokens")) ranges.getJSONObject(i).getJSONObject(measure).remove("hosts")
        val gateway = Gateway().apply { usage = older.toString() }
        val app = App(gateway.url).open()
        waitFor(10.0, "online") { app.onlineThrough(gateway) }
        val refusal = assertThrows(IllegalArgumentException::class.java) { app.usage() }
        assertEquals("Update the host: its usage report is outdated", refusal.message)
    }

    @Test fun gitUsesTheSelectedSessionAndConfirmedRevisionWithoutReplayingUncertainPosts() {
        val gateway = Gateway()
        val app = App(gateway.url).open()
        waitFor(10.0, "online") { app.onlineThrough(gateway) }
        val session = app.session()
        app.select(session.id)
        val menu = app.git(session)
        assertEquals("main", menu.branch)
        assertEquals("feature", app.gitBranches(session).single().name)
        assertEquals("On branch main", app.gitStatus(session))
        val confirmation = GitConfirmation(session, menu, "switch", "feature")
        app.gitAction(confirmation)
        assertNull(app.pending())
        val posted = gateway.gitPosts.single()
        assertEquals(menu.revision, posted.getString("revision"))
        assertEquals(menu.epoch, posted.getString("epoch"))
        assertEquals("feature", posted.getJSONObject("action").getString("branch"))
        app.select(null)
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { app.gitAction(confirmation) }
        app.select(session.id)
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { app.gitAction(confirmation.copy(menu = menu.copy(epoch = "old"))) }
        assertEquals(1, gateway.gitPosts.size)
        gateway.loseGitReply = true
        app.gitAction(confirmation)
        assertTrue(app.pending() != null)
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { app.gitAction(confirmation) }
        app.leave(); app.open()
        waitFor(10.0, "reconnected") { app.onlineThrough(gateway) }
        app.reconcile()
        assertTrue(app.pending() != null)
        assertEquals("an uncertain POST is never automatically retried", 2, gateway.gitPosts.size)
    }

    private fun originAt(port: Int) = "https://127.0.0.1:$port"

    /** A port nothing listens on yet: connecting is refused. */
    private fun freePort() = ServerSocket(0, 1, localhost).use { it.localPort }

    /** Waits for [condition] and returns the seconds it took. */
    private fun waitFor(seconds: Double, what: String, condition: () -> Boolean): Double {
        val start = System.nanoTime()
        while (!condition()) {
            assertTrue("not $what within $seconds s", System.nanoTime() - start < seconds * 1e9)
            Thread.sleep(20)
        }
        return (System.nanoTime() - start) / 1e9
    }

    /** The app's repository over [storage], paired with [urls] if given. */
    private inner class App(private val storage: SecretStorage, vararg urls: String) : AutoCloseable {
        constructor(vararg urls: String) : this(this@GatewayRepositoryTest.storage, *urls)

        private val scope = CoroutineScope(SupervisorJob() + main)
        private val repository: GatewayRepository

        init {
            if (urls.isNotEmpty()) storage.save("pairing", pairingDocument(cert, *urls))
            repository = onMain { GatewayRepository(scope, storage) }
            closing += this
        }

        private fun <T> onMain(block: suspend () -> T): T = runBlocking(main) { block() }
        fun open() = apply { onMain { repository.foreground(true) } }
        fun leave() = onMain { repository.foreground(false) }
        fun pair(document: String) = onMain { repository.pair(document) }
        fun projects() = onMain { repository.projects() }
        fun usage() = onMain { repository.usage() }
        fun context() = onMain { repository.context() }
        fun launch(project: Project) = onMain { repository.launch(project, null) }
        fun pending() = repository.pending.value
        fun session() = repository.state.value.sessions.single()
        fun select(id: String?) = onMain { repository.select(id) }
        fun git(session: Session) = onMain { repository.git(session) }
        fun gitBranches(session: Session) = onMain { repository.gitBranches(session) }
        fun gitStatus(session: Session) = onMain { repository.gitStatus(session) }
        fun gitAction(confirmation: GitConfirmation) = onMain { repository.gitAction(confirmation) }
        fun reconcile() = onMain { repository.reconcile() }
        /** The address of the current or latest connection attempt. */
        fun origin() = onMain { repository.host() }
        /** State and address are read together on the main thread: a stream ending in between cannot pass for the next. */
        fun onlineThrough(gateway: Gateway): Boolean {
            val state = onMain { repository.state.value.takeIf { repository.host() == gateway.url } }
            return state != null && state.connected && state.fresh && gateway.serving()
        }
        override fun close() {
            onMain { repository.logout() }
            scope.cancel()
        }
    }

    /** The gateway at one address. Its event stream starts with the host's snapshot fixture; it has one project and accepts every launch. */
    private inner class Gateway(port: Int = 0) : AutoCloseable {
        val server = MockWebServer()
        /** Method and path of every request, in order. */
        val requests = CopyOnWriteArrayList<String>()
        val gitPosts = CopyOnWriteArrayList<JSONObject>()
        var loseGitReply = false
        /** What `GET /api/v1/usage` returns. */
        var usage = "{}"
        /** What `GET /api/v1/context` returns. */
        var context = "{}"
        private val streams = ConcurrentHashMap.newKeySet<WebSocket>()
        private var closed = false
        private val stream = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                streams += webSocket
                webSocket.send(snapshot)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { streams -= webSocket }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { streams -= webSocket }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { streams -= webSocket }
        }

        init {
            server.useHttps(tls.sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += "${request.method} ${request.path}"
                    val path = request.path!!
                    if (path.endsWith("/git")) {
                        if (request.method == "GET") return MockResponse().setBody(javaClass.classLoader!!.getResource("git.json")!!.readText())
                        val body = JSONObject(request.body.readUtf8()); gitPosts += body
                        if (loseGitReply) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        return MockResponse().setBody(JSONObject().put("requestId", body.getString("requestId")).put("state", "accepted").toString())
                    }
                    if (path.endsWith("/git/branches")) return MockResponse().setBody("""{"branches":[{"name":"feature","current":false,"upstream":null}]}""")
                    if (path.endsWith("/git/status")) return MockResponse().setBody("""{"text":"On branch main"}""")
                    if (path.startsWith("/api/v1/commands/")) return MockResponse().setBody("""{"state":"unknown"}""")
                    return when (request.path) {
                        "/api/v1/events" -> MockResponse().withWebSocketUpgrade(stream)
                        "/api/v1/info" -> MockResponse().setBody("""{"version":1}""")
                        "/api/v1/usage" -> MockResponse().setBody(usage)
                        "/api/v1/context" -> MockResponse().setBody(context)
                        "/api/v1/projects" -> MockResponse().setBody("""{"projects":[{"id":"p","host":null,"label":"project","path":"/project"}],"unreachable":[]}""")
                        "/api/v1/sessions" -> {
                            val id = JSONObject(request.body.readUtf8()).getString("requestId")
                            MockResponse().setBody(JSONObject().put("requestId", id).put("state", "accepted").toString())
                        }
                        else -> MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}""")
                    }
                }
            }
            server.start(localhost, port)
            closing += this
        }

        val url get() = originAt(server.port)
        /** Whether a stream to the app is open here. */
        fun serving() = streams.isNotEmpty()
        fun endStreams() = streams.forEach { it.close(1001, "Going away") }
        override fun close() {
            if (closed) return
            closed = true
            server.shutdown()
        }
    }

    /**
     * A port whose connection queue is full. Linux then drops new connection attempts unanswered, so connecting
     * times out, as it does to the LAN address away from the LAN.
     */
    private inner class Unanswered : AutoCloseable {
        private val listener = ServerSocket(0, 1, localhost)
        private val queued = mutableListOf<Socket>()
        val url = originAt(listener.localPort)

        init {
            closing += this
            while (true) {
                check(queued.size < 64) { "the connection queue did not fill" }
                val socket = Socket()
                try { socket.connect(InetSocketAddress(localhost, listener.localPort), 500) }
                catch (_: SocketTimeoutException) { socket.close(); break }
                queued += socket
            }
        }

        override fun close() {
            queued.forEach(Socket::close)
            listener.close()
        }
    }

    private class MemoryStorage : SecretStorage {
        private val values = ConcurrentHashMap<String, String>()
        override fun read(name: String) = values[name]
        override fun save(name: String, value: String?) { if (value == null) values.remove(name) else values[name] = value }
        override fun clear() = values.clear()
    }
}
