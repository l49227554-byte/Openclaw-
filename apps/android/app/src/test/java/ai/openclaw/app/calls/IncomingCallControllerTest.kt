package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowTelecomManager
import java.util.UUID

@Implements(TelecomManager::class)
class IncomingCallTelecomShadow : ShadowTelecomManager() {
  @Implementation
  @Suppress("UNUSED_PARAMETER")
  protected fun isIncomingCallPermitted(handle: PhoneAccountHandle): Boolean = true
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [IncomingCallTelecomShadow::class])
class IncomingCallControllerTest {
  private class Fixture(
    scope: TestScope,
    start: suspend () -> Unit = {},
  ) {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("secure-calls-test", Context.MODE_PRIVATE))
    var authority = true
    var starts = 0
    var stops = 0
    val id = UUID.randomUUID().toString()
    val payload =
      buildJsonObject {
        put("callId", id)
        put("sessionKey", "agent:assistant:test-call")
        put("callerName", "Assistant")
        put("topic", "Synthetic fixture")
        put("expiresAtMs", System.currentTimeMillis() + 60_000)
      }.toString()
    val controller: IncomingCallController

    init {
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.MANAGE_OWN_CALLS)
      prefs.setIncomingCallsEnabled(true)
      controller =
        IncomingCallController(
          context = app,
          scope = scope.backgroundScope,
          prefs = prefs,
          gatewayId = { "synthetic-gateway" },
          captureAuthority = { { authority } },
          isBusy = { false },
          startAudio = { _, _ ->
            starts++
            start()
          },
          stopAudio = { stops++ },
          setMuted = {},
        )
    }
  }

  @Test
  fun `ringing and declined duplicate never start microphone`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        assertEquals(0, f.starts)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.decline(f.id)
        assertEquals(
          IncomingCallStatus.Declined,
          f.controller.state.value
            ?.status,
        )
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `expired connection lease prevents microphone even on same Gateway`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.authority = false
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
        f.controller.invalidate()
        assertEquals(
          IncomingCallStatus.Ended,
          f.controller.state.value
            ?.status,
        )
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `audio startup timeout closes connecting call and cleans capture`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this) { withTimeout(10) { delay(1000) } }
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(
          IncomingCallStatus.Connecting,
          f.controller.state.value
            ?.status,
        )
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertEquals(0, f.starts)
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        advanceTimeBy(11)
        runCurrent()
        assertEquals(
          IncomingCallStatus.Error,
          f.controller.state.value
            ?.status,
        )
        assertEquals(1, f.stops)
        f.controller.answer(f.id)
        assertEquals(1, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `end before foreground service adoption cannot start audio`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
        f.controller.end(f.id)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertFalse(f.controller.foregroundServiceReady(f.id, service))
        assertEquals(0, f.starts)
        assertEquals(
          IncomingCallStatus.Ended,
          f.controller.state.value
            ?.status,
        )
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `foreground service startup timeout ends accepted call without microphone`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        advanceTimeBy(5_001)
        runCurrent()
        assertEquals(
          IncomingCallStatus.Error,
          f.controller.state.value
            ?.status,
        )
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `blocked call channel rejects invitation instead of silently ringing`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        f.app.getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(IncomingCallController.CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_NONE),
        )
        assertFalse(f.controller.invoke("talk.incoming", f.payload).ok)
        assertEquals(null, f.controller.state.value)
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }
}
