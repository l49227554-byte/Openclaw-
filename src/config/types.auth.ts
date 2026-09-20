// Defines auth profile configuration types.
export type AuthProfileConfig = {
  /** Provider id this auth profile can satisfy. */
  provider: string;
  /**
   * Auth route selected by this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   * - aws-sdk: AWS SDK default credential chain (no secret in auth-profiles.json)
   */
  mode: "api_key" | "aws-sdk" | "oauth" | "token";
  /** Optional account email shown in profile selection/status surfaces. */
  email?: string;
  /** Optional human-readable label shown in profile selection/status surfaces. */
  displayName?: string;
};

export type AuthConfig = {
  /** Named auth profiles keyed by profile id. */
  profiles?: Record<string, AuthProfileConfig>;
  /** Preferred profile order per provider id. */
  order?: Record<string, string[]>;
  /**
   * Operator-declared groups of auth profile ids that are the SAME person's own
   * equivalent identities (e.g. their own Max/SC/SCM subscriptions). A
   * credit/limit-driven failover BETWEEN two profiles in one group preserves the
   * reused CLI session's transcript instead of discarding it as an identity
   * change. Profiles not sharing a declared group keep strict per-account session
   * invalidation. Never affects billing or routing.
   */
  historyEquivalenceGroups?: string[][];
};
