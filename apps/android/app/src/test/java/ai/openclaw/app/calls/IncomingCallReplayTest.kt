package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class IncomingCallReplayTest {
  @Test
  fun `consumed invitation survives prefs recreation without persisting briefing`() {
    val context = RuntimeEnvironment.getApplication()
    val backing = context.getSharedPreferences("calls-test-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, backing)
    val id = UUID.randomUUID().toString()
    val expires = System.currentTimeMillis() + 60_000
    assertTrue(prefs.consumeIncomingCallId(id, expires))
    assertFalse(SecurePrefs(context, backing).consumeIncomingCallId(id, expires))
  }

  @Test
  fun `call surface is private and Telecom binding requires platform permission`() {
    val context = RuntimeEnvironment.getApplication()
    val service = context.packageManager.getServiceInfo(ComponentName(context, IncomingCallConnectionService::class.java), PackageManager.GET_META_DATA)
    assertEquals("android.permission.BIND_TELECOM_CONNECTION_SERVICE", service.permission)
    val activity = context.packageManager.getActivityInfo(ComponentName(context, IncomingCallActivity::class.java), 0)
    assertFalse(activity.exported)
  }
}
