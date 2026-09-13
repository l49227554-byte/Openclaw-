package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.rememberSystemAnimationsEnabled
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun ChatHistoryReveal(
  owner: ChatComposerOwner,
  selectionGeneration: Long,
  loading: Boolean,
  presented: Boolean,
  onPresented: () -> Unit,
  modifier: Modifier = Modifier,
  content: @Composable BoxScope.() -> Unit,
) {
  val animationsEnabled = rememberSystemAnimationsEnabled()
  // Routing verification is not a new transcript; selectionGeneration owns that identity.
  val opacity =
    remember(owner.gatewayStableId, selectionGeneration, loading) {
      Animatable(if (!animationsEnabled || presented) 1f else 0f)
    }
  var skeletonVisible by remember(owner.gatewayStableId, selectionGeneration) { mutableStateOf(false) }
  LaunchedEffect(owner.gatewayStableId, selectionGeneration, loading) {
    if (loading) {
      skeletonVisible = false
      // Fast cache/history reads should reveal content without flashing a placeholder.
      delay(150)
      skeletonVisible = true
    }
  }
  LaunchedEffect(opacity, loading, animationsEnabled, presented) {
    when {
      loading -> Unit
      !animationsEnabled || presented -> opacity.snapTo(1f)
      else -> opacity.animateTo(1f, tween(200, easing = LinearOutSlowInEasing))
    }
    if (!loading) {
      skeletonVisible = false
      onPresented()
    }
  }
  Box(modifier) {
    // Keep the reader composed so history can be laid out before it becomes visible.
    Box(
      modifier =
        Modifier.fillMaxSize().graphicsLayer {
          alpha =
            if (loading) {
              0f
            } else if (animationsEnabled) {
              opacity.value
            } else {
              1f
            }
        },
      content = content,
    )
    // Keep the placeholder through the first animation frame to avoid a blank handoff.
    if (skeletonVisible && (loading || (animationsEnabled && opacity.value == 0f))) {
      ChatHistorySkeleton(animationsEnabled)
    }
  }
}

@Composable
private fun ChatHistorySkeleton(animationsEnabled: Boolean) {
  val loadingDescription = nativeString("Loading thread")
  val sweep =
    if (animationsEnabled) {
      val transition = rememberInfiniteTransition(label = loadingDescription)
      transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing)),
        label = loadingDescription,
      )
    } else {
      null
    }
  val highlight = ClawTheme.colors.borderStrong
  Column(
    modifier =
      Modifier.fillMaxSize().clipToBounds().padding(vertical = 16.dp).clearAndSetSemantics {
        contentDescription = loadingDescription
        progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
      },
    verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.Top),
  ) {
    repeat(3) { index ->
      val user = index == 1
      Column(
        modifier = Modifier.fillMaxWidth(if (user) 0.62f else 0.86f).align(Alignment.End),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.End,
      ) {
        repeat(if (user) 2 else 3) { line ->
          Box(
            Modifier
              .fillMaxWidth(
                if (line == 0) {
                  0.48f
                } else if (line == 2) {
                  0.72f
                } else {
                  1f
                },
              ).height(if (line == 0) 10.dp else 14.dp)
              .clip(RoundedCornerShape(4.dp))
              .background(ClawTheme.colors.surfacePressed)
              .drawWithContent {
                drawContent()
                sweep?.let {
                  val start = size.width * (-0.45f + 1.45f * it.value)
                  drawRect(
                    Brush.linearGradient(
                      colors = listOf(Color.Transparent, highlight, Color.Transparent),
                      start = Offset(start, 0f),
                      end = Offset(start + size.width * 0.45f, 0f),
                    ),
                  )
                }
              },
          )
        }
      }
    }
  }
}
