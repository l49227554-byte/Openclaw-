import { describe, expect, it } from "vitest";
import { resolveSlackThreadTurnMetadata } from "./prepare-thread-turn-metadata.js";

const baseParams = {
  sessionKey: "agent:main:slack:channel:C1:thread:100.000",
  baseSessionKey: "agent:main:slack:channel:C1",
  isThreadReply: false,
  isRoom: true,
  messageTs: "100.000",
  previousTimestamp: undefined,
  threadTs: undefined,
  directThreadRoutedToDmSession: false,
  shouldSeedInitialThreadContext: false,
  bodyForAgent: "Plan the release rollout",
  threadTitleSource: undefined,
};

describe("resolveSlackThreadTurnMetadata", () => {
  it("marks a newly seeded top-level thread and uses its message as the title source", () => {
    expect(resolveSlackThreadTurnMetadata(baseParams)).toEqual({
      ThreadTitleSource: "Plan the release rollout",
      IsFirstThreadTurn: true,
    });
  });

  it("marks a newly seeded reply thread and uses the semantic root as the title source", () => {
    expect(
      resolveSlackThreadTurnMetadata({
        ...baseParams,
        isThreadReply: true,
        messageTs: "101.000",
        threadTs: "100.000",
        shouldSeedInitialThreadContext: true,
        threadTitleSource: "Plan the release rollout",
      }),
    ).toEqual({
      ThreadTitleSource: "Plan the release rollout",
      IsFirstThreadTurn: true,
    });
  });

  it.each([
    {
      name: "the route does not own a thread session",
      params: { sessionKey: baseParams.baseSessionKey },
    },
    {
      name: "the top-level thread session already exists",
      params: { previousTimestamp: 1 },
    },
    {
      name: "a reply is routed back to the direct-message session",
      params: {
        isThreadReply: true,
        threadTs: "100.000",
        shouldSeedInitialThreadContext: true,
        directThreadRoutedToDmSession: true,
      },
    },
  ])("does not mark the first thread turn when $name", ({ params }) => {
    expect(resolveSlackThreadTurnMetadata({ ...baseParams, ...params })).toEqual({
      ThreadTitleSource: undefined,
      IsFirstThreadTurn: undefined,
    });
  });
});
