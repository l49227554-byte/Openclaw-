package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Application
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi", application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatHistoryRevealTest {
  @get:Rule
  val composeRule =
    createComposeRule(
      effectContext =
        object : MotionDurationScale {
          override val scaleFactor = 1f
        },
    )

  private val loading = mutableStateOf(true)
  private val owner = mutableStateOf(ChatComposerOwner("gateway-a", "main", "main"))
  private val selectionGeneration = mutableStateOf(0L)
  private val presented = mutableStateOf(false)
  private val contentColor = mutableStateOf(Color.Red)
  private val mounted = mutableStateOf(true)

  @Test
  fun preloadedContentDoesNotFlashSkeletonOrFade() {
    showReveal()
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    updateState {
      presented.value = true
      loading.value = false
    }
    composeRule.mainClock.advanceTimeByFrame()
    composeRule.mainClock.advanceTimeByFrame()
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    assertEquals(1f, renderedColor().red, 0.02f)
  }

  @Test
  fun loadingAnnouncesProgressThenRevealsContentGraduallyWithoutReplayingOnUpdates() {
    showReveal()
    composeRule.mainClock.advanceTimeBy(100)
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    composeRule.mainClock.advanceTimeBy(100)
    composeRule.onNodeWithContentDescription("Loading thread").assert(
      SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo.Indeterminate),
    )

    finishLoading()
    val start = renderedColor().red
    if (start == 0f) composeRule.onNodeWithContentDescription("Loading thread").assertExists()
    composeRule.mainClock.advanceTimeBy(64)
    val middle = renderedColor().red
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    assertTrue("Loaded messages must fade in rather than appear at full opacity", middle > start && middle > 0.5f && middle < 0.98f)
    composeRule.mainClock.advanceTimeBy(186)
    assertEquals(1f, renderedColor().red, 0.02f)

    updateState { contentColor.value = Color.Green }
    composeRule.mainClock.advanceTimeByFrame()
    assertEquals("A live transcript update must not restart the reveal", 1f, renderedColor().green, 0.02f)

    updateState { mounted.value = false }
    composeRule.mainClock.advanceTimeByFrame()
    updateState { mounted.value = true }
    composeRule.mainClock.advanceTimeByFrame()
    assertEquals("A presented transcript must not fade again after recreation", 1f, renderedColor().green, 0.02f)
  }

  @Test
  fun routingResolutionWithLoadedHistoryDoesNotSkipTheSkeletonHandoff() {
    owner.value = owner.value.copy(routingVerified = false)
    showReveal()
    composeRule.mainClock.advanceTimeBy(200)
    composeRule.onNodeWithContentDescription("Loading thread").assertExists()
    finishLoading()
    updateState { owner.value = owner.value.copy(agentId = "verified-agent", routingVerified = true) }
    composeRule.mainClock.advanceTimeByFrame()
    assertTrue("Routing proof must not make loaded history appear instantly", renderedColor().red < 0.98f)
    composeRule.mainClock.advanceTimeBy(250)
    assertEquals(1f, renderedColor().red, 0.02f)
  }

  @Test
  fun selectionSettlingWithLoadedHistoryPreservesThePresentedSkeletonHandoff() {
    showReveal()
    composeRule.mainClock.advanceTimeBy(200)
    composeRule.onNodeWithContentDescription("Loading thread").assertExists()
    updateState {
      owner.value = owner.value.copy(sessionKey = "selected-chat")
      selectionGeneration.value += 1
      loading.value = false
    }
    composeRule.mainClock.advanceTimeByFrame()
    composeRule.mainClock.advanceTimeByFrame()
    assertTrue("A selection settling with content must still reveal from the skeleton", renderedColor().red < 0.98f)
    composeRule.mainClock.advanceTimeBy(250)
    assertEquals(1f, renderedColor().red, 0.02f)
  }

  @Test
  fun immediatelyPreviewableContentFadesWithoutShowingLoading() {
    loading.value = false
    showReveal()
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    assertTrue("Already available content should reveal on opening", renderedColor().red < 0.98f)
    composeRule.mainClock.advanceTimeBy(64)
    val middle = renderedColor().red
    assertTrue(middle > 0f && middle < 0.98f)
    composeRule.mainClock.advanceTimeBy(200)
    assertEquals(1f, renderedColor().red, 0.02f)
  }

  @Test
  fun changingGatewayOrSelectionRevealsPreviewableContentAgainWithoutLoading() {
    loading.value = false
    showReveal()
    composeRule.mainClock.advanceTimeBy(250)
    for (changeGateway in listOf(true, false)) {
      updateState {
        if (changeGateway) {
          owner.value = owner.value.copy(gatewayStableId = "gateway-b")
        } else {
          selectionGeneration.value += 1
        }
        presented.value = false
      }
      composeRule.mainClock.advanceTimeByFrame()
      composeRule.mainClock.advanceTimeByFrame()
      composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
      assertTrue("New transcript selections must start their own reveal", renderedColor().red < 0.98f)
      composeRule.mainClock.advanceTimeBy(250)
      assertEquals(1f, renderedColor().red, 0.02f)
    }
  }

  @Test
  fun removeAnimationsRevealsLoadedContentImmediately() {
    showReveal(animationsEnabled = false)
    composeRule.mainClock.advanceTimeBy(200)
    composeRule.onNodeWithContentDescription("Loading thread").assertExists()
    finishLoading()
    composeRule.onNodeWithContentDescription("Loading thread").assertDoesNotExist()
    assertEquals(1f, renderedColor().red, 0.02f)
  }

  private fun showReveal(animationsEnabled: Boolean = true) {
    Settings.Global.putFloat(
      RuntimeEnvironment.getApplication().contentResolver,
      Settings.Global.ANIMATOR_DURATION_SCALE,
      if (animationsEnabled) 1f else 0f,
    )
    composeRule.mainClock.autoAdvance = false
    composeRule.setContent {
      ClawDesignTheme {
        if (mounted.value) {
          ChatHistoryReveal(
            owner = owner.value,
            selectionGeneration = selectionGeneration.value,
            loading = loading.value,
            presented = presented.value,
            onPresented = { presented.value = true },
            modifier = Modifier.size(240.dp, 320.dp).background(Color.Black).testTag("history-reveal"),
          ) {
            Box(Modifier.fillMaxSize().background(contentColor.value))
          }
        }
      }
    }
    composeRule.mainClock.advanceTimeByFrame()
    composeRule.waitForIdle()
  }

  private fun updateState(block: () -> Unit) {
    // Publish fixture writes before advancing the paused animation clock.
    composeRule.runOnIdle { Snapshot.withMutableSnapshot(block) }
  }

  private fun finishLoading() {
    updateState { loading.value = false }
    composeRule.mainClock.advanceTimeByFrame()
    composeRule.mainClock.advanceTimeByFrame()
  }

  private fun renderedColor(): Color {
    val pixels = composeRule.onNodeWithTag("history-reveal").captureToImage().toPixelMap()
    return pixels[pixels.width / 2, pixels.height / 2]
  }
}
