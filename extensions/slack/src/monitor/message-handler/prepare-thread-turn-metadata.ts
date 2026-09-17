export type SlackThreadTurnMetadata = {
  ThreadTitleSource?: string;
  IsFirstThreadTurn?: true;
};

export function resolveSlackThreadTurnMetadata(params: {
  sessionKey: string;
  baseSessionKey: string;
  isThreadReply: boolean;
  isRoom: boolean;
  messageTs: string | undefined;
  previousTimestamp: number | undefined;
  threadTs: string | undefined;
  directThreadRoutedToDmSession: boolean;
  shouldSeedInitialThreadContext: boolean;
  bodyForAgent: string;
  threadTitleSource: string | undefined;
}): SlackThreadTurnMetadata {
  const ownsSlackThreadSession = params.sessionKey !== params.baseSessionKey;
  const isNewSeededTopLevelThread = Boolean(
    !params.isThreadReply &&
    params.isRoom &&
    params.messageTs &&
    ownsSlackThreadSession &&
    params.previousTimestamp === undefined,
  );
  const isFirstThreadTurn = Boolean(
    ownsSlackThreadSession &&
    (isNewSeededTopLevelThread ||
      (params.isThreadReply &&
        params.threadTs &&
        !params.directThreadRoutedToDmSession &&
        params.shouldSeedInitialThreadContext)),
  );

  return {
    ThreadTitleSource: isNewSeededTopLevelThread ? params.bodyForAgent : params.threadTitleSource,
    IsFirstThreadTurn: isFirstThreadTurn ? true : undefined,
  };
}
