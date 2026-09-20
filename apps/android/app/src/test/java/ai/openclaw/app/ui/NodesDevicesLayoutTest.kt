package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDevicePairingAction
import ai.openclaw.app.GatewayDevicePairingCapabilities
import ai.openclaw.app.GatewayDevicePairingMutation
import ai.openclaw.app.GatewayDeviceTokenSummary
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPairedDeviceSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w380dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NodesDevicesLayoutTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun compactRowsKeepRemoveWithStatusAndInsetContent() {
    showPanel()
    capture("compact")
    val name = composeRule.onNodeWithText("Paired workstation").getUnclippedBoundsInRoot()
    val remove = composeRule.onNodeWithText("Remove").getUnclippedBoundsInRoot()
    val active = composeRule.onNodeWithText("Active").getUnclippedBoundsInRoot()
    assertTrue("Remove stays in the status column", remove.left >= name.right)
    assertTrue("Action stays close to its status", remove.top - active.bottom < 32.dp)
    assertTrue("The badge is inset from the card edge", composeRule.onNodeWithText("PW").getUnclippedBoundsInRoot().left >= 24.dp)
  }

  @Test
  @Config(qualifiers = "en-rUS-w840dp-h800dp-mdpi")
  fun expandedRowsUseSingleActionStrip() {
    showPanel()
    capture("expanded")
    val remove = composeRule.onNodeWithText("Remove").getUnclippedBoundsInRoot()
    val active = composeRule.onNodeWithText("Active").getUnclippedBoundsInRoot()
    assertTrue("Wide rows do not strand Remove beneath the device", remove.top < active.bottom && active.top < remove.bottom)
  }

  @Test
  fun largeTextKeepsActionsReachableAndRequiresConfirmation() {
    var removed: String? = null
    showPanel(fontScale = 2f, onRemove = { removed = it })
    composeRule
      .onNodeWithText("Remove")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    assertEquals(null, removed)
    composeRule.onAllNodesWithText("Remove")[1].performClick()
    assertEquals("fixture-device", removed)
  }

  @Test
  fun readOnlyDevicesDoNotShowRemoveAction() {
    showPanel(canRemove = false)
    composeRule.onNodeWithText("Remove").assertDoesNotExist()
    composeRule.onNodeWithText("Active").assertIsDisplayed()
  }

  @Test
  fun compactPendingActionsStayTogetherAndRequireConfirmation() {
    var approved: String? = null
    var rejected: String? = null
    showPanel(pending = true, onApprove = { request, device -> approved = "$request/$device" }, onReject = { rejected = it })
    capture("pending-compact")
    val review = composeRule.onNodeWithText("Review").getUnclippedBoundsInRoot()
    val reject = composeRule.onNodeWithText("Reject").getUnclippedBoundsInRoot()
    val approve = composeRule.onNodeWithText("Approve").getUnclippedBoundsInRoot()
    assertTrue("Compact actions stay in one status column", reject.top >= review.bottom && approve.top >= reject.bottom)
    composeRule.onNodeWithText("Approve").performClick()
    assertEquals(null, approved)
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.onNodeWithText("Reject").performClick()
    assertEquals(null, rejected)
    composeRule.onAllNodesWithText("Reject")[1].performClick()
    assertEquals("fixture-request", rejected)
    composeRule.onNodeWithText("Approve").performClick()
    composeRule.onAllNodesWithText("Approve")[1].performClick()
    assertEquals("fixture-request/fixture-new-device", approved)
  }

  @Test
  @Config(qualifiers = "en-rUS-w840dp-h800dp-mdpi")
  fun expandedPendingActionsShareStatusStrip() {
    showPanel(pending = true)
    capture("pending-expanded")
    val status = composeRule.onNodeWithText("Review").getUnclippedBoundsInRoot()
    for (label in listOf("Reject", "Approve")) {
      val action = composeRule.onNodeWithText(label).getUnclippedBoundsInRoot()
      assertTrue("Wide pending actions align with status", action.top < status.bottom && status.top < action.bottom)
    }
  }

  @Test
  fun pendingAndPairedActionsAreDisabledDuringMutation() {
    showPanel(pending = true, mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Remove, "fixture-device"))
    for (label in listOf("Reject", "Approve", "Remove")) {
      composeRule.onNodeWithText(label).assertIsNotEnabled()
    }
  }

  @Test
  @Config(qualifiers = "en-rUS-w320dp-h800dp-mdpi")
  fun narrowLargeTextKeepsPendingActionsReachable() {
    showPanel(fontScale = 2f, pending = true)
    for (label in listOf("Reject", "Approve", "Remove")) {
      composeRule.onNodeWithText(label).performScrollTo().assertIsDisplayed()
    }
  }

  private fun showPanel(
    fontScale: Float = 1f,
    canRemove: Boolean = true,
    onRemove: (String) -> Unit = {},
    pending: Boolean = false,
    mutation: GatewayDevicePairingMutation? = null,
    onApprove: (String, String) -> Unit = { _, _ -> },
    onReject: (String) -> Unit = {},
  ) {
    composeRule.setContent {
      ClawDesignTheme {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
          Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp)) {
            NodesDevicesPanel(
              summary =
                GatewayNodesDevicesSummary(
                  nodes =
                    listOf(
                      GatewayNodeSummary(
                        id = "fixture-node",
                        displayName = "Workstation",
                        remoteIp = null,
                        version = "2026.9.5",
                        deviceFamily = "Linux",
                        paired = true,
                        connected = true,
                        approvalState = GatewayNodeCapabilityApproval.Approved,
                        capabilities = emptyList(),
                        commands = listOf("browser.proxy", "system.run"),
                      ),
                    ),
                  pendingDevices =
                    if (pending) {
                      listOf(
                        GatewayPendingDeviceSummary(
                          requestId = "fixture-request",
                          deviceId = "fixture-new-device",
                          displayName = "New workstation",
                          remoteIp = "192.0.2.20",
                          roles = listOf("operator"),
                          scopes = listOf("operator.read"),
                          requestedAtMs = null,
                          repair = false,
                        ),
                      )
                    } else {
                      emptyList()
                    },
                  pairedDevices =
                    listOf(
                      GatewayPairedDeviceSummary(
                        deviceId = "fixture-device",
                        displayName = "Paired workstation",
                        remoteIp = "192.0.2.10",
                        roles = listOf("node", "operator"),
                        scopes = listOf("operator.read", "operator.write"),
                        tokens = listOf(GatewayDeviceTokenSummary("operator", emptyList(), false, null)),
                        approvedAtMs = null,
                      ),
                    ),
                ),
              pairingCapabilities = GatewayDevicePairingCapabilities(canList = true, canRemove = canRemove, canApprove = pending, canReject = pending),
              callerScopes = listOf("operator.admin"),
              pairingMutation = mutation,
              activeGatewayStableId = "fixture-gateway",
              onApprove = onApprove,
              onReject = onReject,
              onRemove = onRemove,
            )
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun capture(size: String) {
    System.getenv("OPENCLAW_LAYOUT_SCREENSHOT_DIR")?.let { path ->
      File(path, "$size.png").apply { parentFile?.mkdirs() }.outputStream().use {
        check(
          composeRule
            .onRoot()
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it),
        )
      }
    }
  }
}
