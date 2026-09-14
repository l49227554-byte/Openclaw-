package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelSummary
import androidx.room3.Entity

internal const val MODEL_DESCRIPTOR_CACHE_TTL_MS = 24L * 60 * 60 * 1_000

internal data class CachedModelDescriptor(
  val modelRef: String,
  val displayName: String,
  val verifiedBootId: String?,
  val verifiedAtMs: Long,
) {
  fun isFresh(
    bootId: String?,
    nowMs: Long,
  ): Boolean {
    val currentBootId = bootId?.trim()?.takeIf(String::isNotEmpty)
    val ageMs = nowMs - verifiedAtMs
    return verifiedBootId == currentBootId && ageMs in 0..<MODEL_DESCRIPTOR_CACHE_TTL_MS
  }
}

internal fun GatewayModelSummary.toCachedModelDescriptor(
  bootId: String?,
  verifiedAtMs: Long,
): CachedModelDescriptor? {
  val modelRef = providerQualifiedRef()
  val displayName = friendlyDisplayName(modelRef) ?: return null
  return CachedModelDescriptor(
    modelRef = modelRef,
    displayName = displayName,
    verifiedBootId = bootId?.trim()?.takeIf(String::isNotEmpty),
    verifiedAtMs = verifiedAtMs,
  )
}

internal interface ChatModelDescriptorCache {
  suspend fun load(
    gatewayId: String,
    agentId: String,
  ): List<CachedModelDescriptor>

  suspend fun save(
    gatewayId: String,
    agentId: String,
    bootId: String?,
    verifiedAtMs: Long,
    models: List<GatewayModelSummary>,
  )

  suspend fun clearGateway(gatewayId: String)
}

@Entity(tableName = "cached_model_descriptors", primaryKeys = ["gatewayId", "agentId", "modelRef"])
internal data class CachedModelDescriptorEntity(
  val gatewayId: String,
  val agentId: String,
  val modelRef: String,
  val displayName: String,
  val verifiedBootId: String?,
  val verifiedAtMs: Long,
)

internal class RoomChatModelDescriptorCache(
  private val database: GatewayCacheDatabase,
) : ChatModelDescriptorCache {
  override suspend fun load(
    gatewayId: String,
    agentId: String,
  ): List<CachedModelDescriptor> {
    val gateway = gatewayId.trim().takeIf(String::isNotEmpty) ?: return emptyList()
    val agent = agentId.trim().takeIf(String::isNotEmpty) ?: return emptyList()
    return database.dao().modelDescriptors(gateway, agent).map { row ->
      CachedModelDescriptor(
        modelRef = row.modelRef,
        displayName = row.displayName,
        verifiedBootId = row.verifiedBootId,
        verifiedAtMs = row.verifiedAtMs,
      )
    }
  }

  override suspend fun save(
    gatewayId: String,
    agentId: String,
    bootId: String?,
    verifiedAtMs: Long,
    models: List<GatewayModelSummary>,
  ) {
    val gateway = gatewayId.trim().takeIf(String::isNotEmpty) ?: return
    val agent = agentId.trim().takeIf(String::isNotEmpty) ?: return
    val rows =
      models.mapNotNull { model ->
        val descriptor = model.toCachedModelDescriptor(bootId, verifiedAtMs) ?: return@mapNotNull null
        CachedModelDescriptorEntity(
          gatewayId = gateway,
          agentId = agent,
          modelRef = descriptor.modelRef,
          displayName = descriptor.displayName,
          verifiedBootId = descriptor.verifiedBootId,
          verifiedAtMs = descriptor.verifiedAtMs,
        )
      }
    if (rows.isNotEmpty()) database.dao().upsertModelDescriptors(rows)
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = gatewayId.trim().takeIf(String::isNotEmpty) ?: return
    database.dao().deleteModelDescriptors(gateway)
  }
}

private fun GatewayModelSummary.providerQualifiedRef(): String {
  val normalizedId = id.trim()
  val normalizedProvider = provider.trim()
  if (normalizedProvider.isEmpty() || normalizedId.startsWith("$normalizedProvider/")) return normalizedId
  return "$normalizedProvider/$normalizedId"
}

private fun GatewayModelSummary.friendlyDisplayName(modelRef: String): String? {
  val normalizedName = name.trim().takeIf(String::isNotEmpty) ?: return null
  val rawId = modelRef.substringAfterLast('/')
  return normalizedName.takeUnless { it == rawId || it == id.trim() || it == modelRef }
}
