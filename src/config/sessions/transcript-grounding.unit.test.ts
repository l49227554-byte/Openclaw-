import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGrounding,
} from "../../media/media-reference.js";
import { invalidateUngroundedMediaPrefixes } from "./transcript-grounding.js";

const REDACTED = "[unverified media reference removed]";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function grounding(
  rootAliases: string[],
  authorizedAliases: string[] = [],
  caseInsensitivePaths = false,
  uriRoots: string[] = ["media://inbound"],
): ManagedMediaGrounding {
  return { authorizedAliases, caseInsensitivePaths, rootAliases, uriRoots };
}

describe("invalidateUngroundedMediaPrefixes", () => {
  const root = "/managed/state/media";

  it("invalidates only the absolute managed prefix and preserves every suffix byte", () => {
    const input = `claim "${root}/invented name.jpg?x=1#preview" then ${root}/../secret`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(
      `claim "${REDACTED}/invented name.jpg?x=1#preview" then ${REDACTED}/../secret`,
    );
  });

  it("preserves only a longest authorized alias at an exact terminal boundary", () => {
    const real = `${root}/inbound/real photo(1).jpg`;
    const input = `real "${real}" suffix ${real}.fake ads ${real}:stream`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root], [real]))).toBe(
      `real "${real}" suffix ${REDACTED}/inbound/real photo(1).jpg.fake ads ${REDACTED}/inbound/real photo(1).jpg:stream`,
    );
  });

  it.each([".", ",", ";", ":", "!", "?", "\u2014"])(
    "accepts a terminal punctuation run after an authorized alias: %s",
    (suffix) => {
      const real = `${root}/real.jpg`;
      expect(
        invalidateUngroundedMediaPrefixes(`${real}${suffix} next`, grounding([root], [real])),
      ).toBe(`${real}${suffix} next`);
    },
  );

  it("invalidates file URL roots, including relative, encoded, localhost, and double-slash forms", () => {
    const roots = [
      "file:managed/state%20dir/media",
      "file:/managed/state%20dir/media",
      "file:///managed/state%20dir/media",
      "file:////managed/state%20dir/media",
      "file://localhost/managed/state%20dir/media",
      "file://localhost//managed/state%20dir/media",
    ];
    for (const alias of roots) {
      expect(invalidateUngroundedMediaPrefixes(`${alias}/fake.png`, grounding(roots))).toBe(
        `${REDACTED}/fake.png`,
      );
    }
  });

  it.each(["MEDIA:", "IMAGE:", "custom:", "path=", "(", "..."])(
    "invalidates a managed root after directive or punctuation bytes: %s",
    (prefix) => {
      expect(
        invalidateUngroundedMediaPrefixes(`${prefix}${root}/fake.png`, grounding([root])),
      ).toBe(`${prefix}${REDACTED}/fake.png`);
    },
  );

  it.each(['claim "', "claim (`"])(
    "invalidates without consuming an unmatched opening wrapper: %s",
    (prefix) => {
      expect(
        invalidateUngroundedMediaPrefixes(`${prefix}${root}/fake.png`, grounding([root])),
      ).toBe(`${prefix}${REDACTED}/fake.png`);
    },
  );

  it("leaves non-file URI occurrences, remote file authorities, root siblings, and unrelated paths", () => {
    const roots = [root, `file:///${root}`];
    const inputs = [
      `https://example.test/?path=${root}/fake.png`,
      `custom://example.test/?path=${root}/fake.png`,
      "file://attacker/managed/state/media/fake.png",
      `${root}-backup/fake.png`,
      "/tmp/fake.png",
    ];
    for (const input of inputs) {
      expect(invalidateUngroundedMediaPrefixes(input, grounding(roots))).toBe(input);
    }
  });

  it("invalidates media-store URIs in either scheme case and keeps an authorized one exact", () => {
    const granted = "media://inbound/granted.jpg";
    const input = `ok ${granted}; forged media://inbound/forged.jpg, shout MEDIA://inbound/forged.jpg (${granted}.fake)`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root], [granted]))).toBe(
      `ok ${granted}; forged ${REDACTED}/forged.jpg, shout ${REDACTED}/forged.jpg (${REDACTED}/granted.jpg.fake)`,
    );
  });

  it("leaves media URI look-alikes that the media store cannot resolve", () => {
    const inputs = [
      "multimedia://inbound/fake.jpg",
      "https://cdn.example.test/media://inbound/fake.jpg",
      "media://inboundx/fake.jpg",
      "media:///inbound/fake.jpg",
    ];
    for (const input of inputs) {
      expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(input);
    }
  });

  it("matches URI schemes and authorities case-insensitively while path bytes stay exact", () => {
    const roots = [root, `file://${root}`, `file://localhost${root}`];
    const granted = `file://${root}/granted.jpg`;
    for (const [input, expected] of [
      [`FILE://${root}/forged.jpg`, `${REDACTED}/forged.jpg`],
      [`file://LOCALHOST${root}/forged.jpg`, `${REDACTED}/forged.jpg`],
      [`FILE://${root}/granted.jpg`, `FILE://${root}/granted.jpg`],
      [`file://${root}/GRANTED.jpg`, `${REDACTED}/GRANTED.jpg`],
    ] as const) {
      expect(invalidateUngroundedMediaPrefixes(input, grounding(roots, [granted]))).toBe(expected);
    }
  });

  it("does not rescan prefixes when a bounded prompt has no managed root", () => {
    const input = "x".repeat(32 * 1_024);
    const slice = vi.spyOn(String.prototype, "slice");
    const result = invalidateUngroundedMediaPrefixes(input, grounding([root]));
    const sliceCalls = slice.mock.calls.length;
    slice.mockRestore();

    expect(result).toBe(input);
    expect(sliceCalls).toBe(0);
  });

  it.each([
    ["C:/Users/Bot/state/media", "c:/users/bot/STATE/media/fake.png"],
    ["//?/C:/Users/Bot/state/media", "//?/c:/users/bot/state/MEDIA/fake.png"],
    ["//server/share/media", "//SERVER/SHARE/MEDIA/fake.png"],
    ["//?/UNC/server/share/media", "//?/unc/SERVER/share/media/fake.png"],
    ["/private/var/state/media", "/private/VAR/state/media/fake.png"],
  ])(
    "supports exact foreign alias forms with owner-provided case semantics: %s",
    (alias, input) => {
      expect(invalidateUngroundedMediaPrefixes(input, grounding([alias], [], true))).toBe(
        `${REDACTED}/fake.png`,
      );
    },
  );

  it.each([" ", ")", "]", '"', "`", ",", ":", "\u2014"])(
    "treats every character in a configured root as literal: %j",
    (terminator) => {
      const unusualRoot = `/srv/openclaw${terminator}prod/media`;
      expect(
        invalidateUngroundedMediaPrefixes(
          `${unusualRoot}/generated/fake.png`,
          grounding([unusualRoot]),
        ),
      ).toBe(`${REDACTED}/generated/fake.png`);
    },
  );
  it.each([
    // Each of these resolves to a file under the managed root while matching no alias.
    // The root matches literally here; the dot segment sits in the SUFFIX, which the
    // matcher preserves byte for byte.
    [`${root}/./inbound/private.png`, "/./inbound/private.png"],
    ["/managed/state/./media/inbound/private.png", "/inbound/private.png"],
    ["/managed/state/x/../media/inbound/private.png", "/inbound/private.png"],
    ["/managed/state/a/b/../../media/inbound/private.png", "/inbound/private.png"],
  ])("redacts a managed path spelled with dot segments: %s", (input, suffix) => {
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(
      `${REDACTED}${suffix}`,
    );
  });

  it("redacts a dot-segment path that exhausts the normalization budget", () => {
    // `.` is a no-op that must not consume budget: when it did, ~140 characters of "./"
    // padding was reported as unmanaged and replayed, reopening the bypass. A token that
    // begins at a managed root and cannot be decided is redacted, not replayed.
    const padded = `/managed/${"./".repeat(80)}state/media/inbound/private.png`;
    expect(invalidateUngroundedMediaPrefixes(padded, grounding([root]))).toContain(REDACTED);
  });

  it("redacts a managed path reached through a leading separator run", () => {
    // POSIX folds "//managed/x" to "/managed/x", so this names a file under the root while
    // matching no alias; the stem prefilter has to look past the separators.
    const input = `/${root}/inbound/private.png`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(
      `${REDACTED}/inbound/private.png`,
    );
  });

  it("folds NFC/NFD when the accent is not in the last segment", () => {
    // The escape hatch that sends non-ASCII roots to the fold was keyed on the LAST segment,
    // so "/managed/\u00e9tat/media" looked ASCII (its last segment is) and the byte-literal
    // segment scan then missed every NFD spelling of the accented middle segment.
    const nfcRoot = "/managed/\u00e9tat/media";
    const g = grounding([nfcRoot], [], false, []);
    for (const spelling of [
      "/managed/\u00e9tat/media/inbound/x.png",
      "/managed/e\u0301tat/media/inbound/x.png",
      "/managed/e\u0301tat/./media/inbound/x.png",
    ]) {
      expect(invalidateUngroundedMediaPrefixes(spelling, g)).toBe(`${REDACTED}/inbound/x.png`);
    }
    const unrelated = "/managed/etat/media/inbound/x.png";
    expect(invalidateUngroundedMediaPrefixes(unrelated, g)).toBe(unrelated);
  });

  it("leaves a long absolute-path list alone when it cannot reach the root", () => {
    // The cost caps refuse a token by REDACTING it, so admission decides what ordinary text
    // they can eat. Matching on the root's last segment alone admitted any absolute-path list
    // containing the word "media", and a 41-entry PATH lost its tail to the segment cap.
    // Folding removes segments and never invents a segment name, so requiring every root
    // segment cannot reject a token the parser would fold in.
    const g = grounding([root], [], false, []);
    const searchPath = [
      ...Array.from({ length: 40 }, (_unused, index) => `/opt/tool${index}/bin`),
      "/usr/lib/media/bin",
    ].join(":");
    expect(invalidateUngroundedMediaPrefixes(searchPath, g)).toBe(searchPath);
    const heavier = Array.from({ length: 80 }, (_unused, index) => `/opt/media/x${index}`).join(
      ":",
    );
    expect(invalidateUngroundedMediaPrefixes(heavier, g)).toBe(heavier);
    // ...and a token that CAN reach the root is still refused rather than replayed.
    expect(invalidateUngroundedMediaPrefixes(`/managed/state/./media/x.png`, g)).toBe(
      `${REDACTED}/x.png`,
    );
  });

  it("does not let one remote URL suppress redaction in later tokens", () => {
    // The remote-URI guard is memoized per token, and reading that memo before the token
    // change was noticed compared the cursor against the PREVIOUS token's offset. Since the
    // cursor only grows, the guard read true and every managed path after a URL was replayed.
    // No other test here spans two tokens, which is why it survived a round of review.
    const g = grounding([root], [], false, []);
    expect(
      invalidateUngroundedMediaPrefixes(
        `http://h/./managed/state/media/a.png ${root}/inbound/secret.png`,
        g,
      ),
    ).toBe(`http://h/./managed/state/media/a.png ${REDACTED}/inbound/secret.png`);
    // Still suppressed WITHIN the URL's own token, which is the guard's actual job.
    const sameToken = "http://h/managed/state/media/a.png";
    expect(invalidateUngroundedMediaPrefixes(sameToken, g)).toBe(sameToken);
  });

  it("refuses a URI token whose separators are percent-encoded", () => {
    // Candidates are cut at RAW separators, but decoding turns %2F into one, so a token
    // spelling its separator that way has no raw cut at the end of the root and equality can
    // never be reached. The exact prefix is unknowable, so the token is refused whole rather
    // than replayed.
    const g = grounding([root], [], false, ["file:///managed/state/media"]);
    for (const encoded of [
      "file:///managed/state/media%2Finbound%2Fprivate.png",
      "file:///managed/state/media%5Cinbound.png",
    ]) {
      expect(invalidateUngroundedMediaPrefixes(encoded, g)).toBe(REDACTED);
    }
    // A DIFFERENT root encoded the same way is still none of our business.
    for (const unrelated of ["file:///other/state/media%2Fx.png"]) {
      expect(invalidateUngroundedMediaPrefixes(unrelated, g)).toBe(unrelated);
    }
  });

  it("decides a token's remote-URI status once", () => {
    // Past the per-token walk cap every remaining position still re-ran an unanchored regex
    // over the token prefix, so a long scheme-like run plus ":/" padding cost O(N*M): 24s
    // measured, 100ms after memoizing the threshold. The TIMEOUT is the assertion here.
    // This token is crafted and does get refused - the cap failing closed, which predates
    // this change - so the output is checked for boundedness, not equality.
    const flood = `${"a".repeat(60_000)}://b/${":/".repeat(60_000)}%`;
    const out = invalidateUngroundedMediaPrefixes(flood, grounding([root]));
    expect(out.match(/unverified media reference removed/gu) ?? []).toHaveLength(1);
    expect(out.length).toBeLessThan(flood.length);
  }, 10_000);

  it("keeps the cursor moving forward after an alias jump", () => {
    // A redaction jump can cross a token boundary INSIDE the matched alias, because user
    // directories contain spaces. The token memo was keyed on a tokenStart the jump never
    // refreshed, so the cached extent could end up behind the cursor and the walk cap could
    // return a negative length - moving the cursor backward and emitting text twice.
    const spaced = "C:/Users/John Doe/.openclaw/media";
    const token = `%${spaced}/${":/".repeat(40)}`;
    const out = invalidateUngroundedMediaPrefixes(token, grounding([spaced], [], false, []));
    expect(out.match(/unverified media reference removed/gu)).toHaveLength(1);
    expect(out).toBe(`%${REDACTED}/${":/".repeat(40)}`);
  });

  it("folds a non-ASCII URI root in every spelling", () => {
    // new URL().pathname percent-encodes non-ASCII, so a root stored straight from the parser
    // read "/managed/state/m%C3%A9dia". The admission gate looked for that literal, the
    // NFC/NFD fold was a no-op on an all-ASCII encoded string, and both the dot-segment and
    // NFD spellings replayed. Both sides are decoded exactly once now.
    const uriRoot = "file://localhost/managed/state/m\u00e9dia";
    const g = grounding([], [], false, [uriRoot]);
    for (const spelling of [
      `file://localhost/managed/state/m\u00e9dia/x.png`,
      `file://localhost/managed/state/./m\u00e9dia/x.png`,
      `file://localhost/managed/state/me\u0301dia/x.png`,
      `file://localhost/managed/state/m%C3%A9dia/x.png`,
    ]) {
      expect(invalidateUngroundedMediaPrefixes(spelling, g)).toBe(`${REDACTED}/x.png`);
    }
    for (const unrelated of [
      `file://localhost/other/state/m\u00e9dia/x.png`,
      `file://localhost/managed/state/m\u00e9diax/x.png`,
    ]) {
      expect(invalidateUngroundedMediaPrefixes(unrelated, g)).toBe(unrelated);
    }
  });

  it("replays a file URL whose escapes do not decode", () => {
    // A decode failure was treated as "cannot decide" and redacted the whole token. WHATWG
    // leaves a % that is not followed by two hex digits alone, so ordinary transcript URLs
    // hit it. The owner's own decode would reject these too, so they name no managed file.
    const g = grounding([root], [], false, ["file:///managed/state/media"]);
    for (const benign of [
      "file:///docs/100%_done.pdf",
      "file:///tmp/%E9t%E9.txt",
      "file:///Users/me/My%20Documents/report.pdf",
    ]) {
      expect(invalidateUngroundedMediaPrefixes(benign, g)).toBe(benign);
    }
    expect(invalidateUngroundedMediaPrefixes("file:///managed/state/./media/x.png", g)).toBe(
      `${REDACTED}/x.png`,
    );
  });

  it("folds NFC and NFD spellings of the same root", () => {
    // APFS resolves "caf\u00e9" and "cafe\u0301" to one directory, so a transcript spelling the
    // root the other way named a managed file and matched nothing. Reported by
    // claude-air-opus5-477349 against the pre-phase-2 matcher and reproduced here.
    const nfc = "/managed/state/caf\u00e9";
    const nfd = "/managed/state/cafe\u0301";
    expect(nfc).not.toBe(nfd);
    expect(
      invalidateUngroundedMediaPrefixes(`${nfd}/inbound/x.png`, grounding([nfc], [], false, [])),
    ).toBe(`${REDACTED}/inbound/x.png`);
    expect(
      invalidateUngroundedMediaPrefixes(`${nfc}/inbound/x.png`, grounding([nfd], [], false, [])),
    ).toBe(`${REDACTED}/inbound/x.png`);
    // Through a dot segment too, so the fold and the normalization compose.
    expect(
      invalidateUngroundedMediaPrefixes(
        `/managed/state/./cafe\u0301/inbound/x.png`,
        grounding([nfc], [], false, []),
      ),
    ).toBe(`${REDACTED}/inbound/x.png`);
    // A DIFFERENT character is still a different directory - this folds spellings, not accents.
    for (const unrelated of [
      `/managed/state/caf\u00e8/inbound/x.png`,
      `/managed/state/cafe/inbound/x.png`,
      `/other/state/caf\u00e9/x.png`,
    ]) {
      expect(invalidateUngroundedMediaPrefixes(unrelated, grounding([nfc], [], false, []))).toBe(
        unrelated,
      );
    }
  });

  it("leaves text that cannot name a root alone", () => {
    // Over-redaction is a visible product regression, not a safe default. Each of these was
    // mangled by a cost guard that fired before deciding whether a root was even in play: the
    // per-token walk cap counted colons, and any percent-escape was treated as hostile.
    const g = grounding([root], [], false, ["media://inbound", `file://localhost${root}`]);
    for (const benign of [
      "tokio::sync::mpsc::error::SendError::Full",
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/opt/bin",
      "file:///Users/me/My%20Documents/report.pdf",
      "file:///Users/me/B%C3%BCcher/media/photo.png",
      "/managed/state/mediax/p.png",
    ]) {
      expect(invalidateUngroundedMediaPrefixes(benign, g)).toBe(benign);
    }
  });

  it("folds after every predecessor the literal matcher accepts", () => {
    // The two gates have to agree. While the fold ran only at a token start (or after ":"),
    // "../managed/state/media/x" was redacted as a literal hit while its dot-segment twin was
    // replayed - the literal matcher accepts any non-word, non-separator predecessor.
    const g = grounding([root], [], false, ["media://inbound", `file://localhost${root}`]);
    expect(invalidateUngroundedMediaPrefixes(`../managed/state/./media/inbound/x.png`, g)).toBe(
      `..${REDACTED}/inbound/x.png`,
    );
    expect(invalidateUngroundedMediaPrefixes(`foo,/managed/state/./media/x.png`, g)).toBe(
      `foo,${REDACTED}/x.png`,
    );
  });

  it("folds a URI spelling whose authority differs from the root's", () => {
    // The gate compared the raw scheme+authority, but WHATWG folds an empty file: host,
    // "localhost" and "LOCALHOST" to one authority. Gating on that text rejected spellings
    // the parser resolves into the root, which is the one thing the gate must never do.
    expect(
      invalidateUngroundedMediaPrefixes(
        `file:///managed/state/./media/x.png`,
        grounding([root], [], false, [`file://localhost${root}`]),
      ),
    ).toBe(`${REDACTED}/x.png`);
    // ":" is not a token boundary, so a root after a scheme colon is a literal hit one
    // position into the token and has to be a fold candidate there too.
    expect(
      invalidateUngroundedMediaPrefixes(
        `file:/managed/state/./media/x.png`,
        grounding([root], [], false, [`file://${root}`]),
      ),
    ).toBe(`${REDACTED}/x.png`);
  });

  it("folds a drive-letter root", () => {
    // Not a regression test: this already held. It pins WHY, which is not obvious - URI_PREFIX
    // matches "C:" as a SCHEME, so a Windows root takes the URI branch and the parser hands
    // back pathname "/managed/state/media". A reviewer read this as broken; the control proved
    // it was not. Narrowing URI_PREFIX would silently disable folding on Windows.
    expect(
      invalidateUngroundedMediaPrefixes(
        String.raw`C:\managed\state\.\media\x.png`,
        grounding(["C:/managed/state/media"], [], false, []),
      ),
    ).toBe(String.raw`${REDACTED}\x.png`);
  });

  it("bounds the admission scan to the token, not the prompt", () => {
    // The containment gate used indexOf from the token start, which scans to the end of the
    // whole prompt. A prompt of many one-character absolute tokens paid two full-text scans
    // each - the same quadratic, reached with many short tokens instead of one long one.
    // Sized so the two arms cannot be confused: measured 159ms bounded against ~21s
    // unbounded. At 150k the unbounded version finished in 735ms and the test proved nothing,
    // which is how the first version of this test passed against the bug it was written for.
    const flood = "/ ".repeat(700_000);
    expect(invalidateUngroundedMediaPrefixes(flood, grounding([root]))).toBe(flood);
  }, 10_000);

  it("redacts a URI root reached through a non-dot segment or an escaped dot", () => {
    // The prefilter used to require the root's first segment right after the separator run,
    // so any OTHER leading segment kept the token out of the fold entirely. WHATWG folds
    // "/x/.." in the path and treats "%2e" as a dot segment, so both name the managed root.
    const g = grounding([root], [], false, ["media://inbound", `file://localhost${root}`]);
    expect(
      invalidateUngroundedMediaPrefixes(
        `file://localhost/x/../managed/state/media/inbound/p.png`,
        g,
      ),
    ).toBe(`${REDACTED}/inbound/p.png`);
    expect(
      invalidateUngroundedMediaPrefixes(
        `file://localhost/x/y/../../managed/state/media/inbound/p.png`,
        g,
      ),
    ).toBe(`${REDACTED}/inbound/p.png`);
    expect(
      invalidateUngroundedMediaPrefixes(
        `file:///%2e/managed/state/media/inbound/p.png`,
        grounding([root], [], false, [`file://${root}`]),
      ),
    ).toBe(`${REDACTED}/inbound/p.png`);
  });

  it("decides a remote-URI token once instead of at every dot segment inside it", () => {
    // Phase 2 used to re-enter per position, and for a token already carrying a remote URI
    // the suppressing guard ran only AFTER the fold, so every other position paid an O(N)
    // token scan plus an O(N) guard: this input took 178s. The timeout is the assertion.
    const flood = `http://a.com/${"/.".repeat(100_000)}`;
    expect(invalidateUngroundedMediaPrefixes(flood, grounding([root]))).toBe(flood);
  }, 10_000);

  it("redacts a file:// authority root reached through leading dot segments", () => {
    // The stem prefilter required the root's first segment immediately after the separator
    // run, so a token whose path STARTS with a dot segment never entered the walk. For a
    // plain root the literal matcher caught the root later in the token; behind a file://
    // authority the remote-URI guard suppressed that fallback and the path was replayed.
    const uriRoot = `file://localhost${root}`;
    const g = grounding([root], [], false, ["media://inbound", uriRoot]);
    for (const token of [
      `file://localhost/./managed/state/media/inbound/private.png`,
      `file://localhost/../managed/state/media/inbound/private.png`,
    ]) {
      expect(invalidateUngroundedMediaPrefixes(token, g)).toBe(`${REDACTED}/inbound/private.png`);
    }
  });

  it("folds a leading .. at the root instead of calling it a miss", () => {
    // Every token the walk sees starts at a separator run, so it is rooted, and /../x
    // resolves to /x for both POSIX and WHATWG. Returning "outside the root" for ".." on an
    // empty stack replayed the path.
    expect(
      invalidateUngroundedMediaPrefixes(`/../managed/state/media/inbound/x.png`, grounding([root])),
    ).toBe(`${REDACTED}/inbound/x.png`);
  });

  it("does not rescan a separator run from every position inside it", () => {
    // Phase 2 re-entered at every position of a separator run and each entry scanned to the
    // end of the run, so N separators cost O(N^2): this input took 119s before the guard
    // excluded "/" and 151ms after. The timeout IS the assertion. 10s rather than a tight
    // bound so a loaded CI box cannot fail it, and still 12x under the quadratic.
    const flood = `${"/".repeat(200_000)}x`;
    expect(invalidateUngroundedMediaPrefixes(flood, grounding([root]))).toBe(flood);
  }, 10_000);

  it("redacts a file:// managed root spelled with dot segments", () => {
    // WHATWG URL folds dot segments in the PATH exactly as path normalization does, so
    // excluding URI roots from the walk left the same bypass on a different spelling.
    const uriRoot = `file://${root}`;
    expect(
      invalidateUngroundedMediaPrefixes(
        `file:///managed/state/./media/inbound/private.png`,
        grounding([uriRoot]),
      ),
    ).toBe(`${REDACTED}/inbound/private.png`);
  });

  it.each([
    // A literal root hit that fails its trailing-boundary check must not end the attempt:
    // this matches the root, fails on "2", and still resolves back into the root.
    [`${root}2/../media/inbound/private.png`, [root]],
    // Longer than any real managed path: refused rather than truncated, because scanning a
    // prefix and reporting "root not reached" replayed padding that ran past the cap.
    [`/managed/${"./".repeat(2100)}state/media/inbound/private.png`, [root]],
    // ".." costs budget, so this ends undecidable rather than silently unmanaged.
    [`/managed/${"a/../".repeat(40)}state/media/inbound/private.png`, [root]],
    // WHATWG folds %2e as a dot segment before decoding; the walk refuses to guess.
    ["file:///managed/state/%2e/media/inbound/private.png", [`file://${root}`]],
    // The prefilter is all-lowercase while the walk uses owner-folded bytes; deriving one
    // from the other disabled phase 2 for mixed-case roots under case-sensitive rules.
    ["/Managed/State/./Media/inbound/private.png", ["/Managed/State/Media"]],
  ])("redacts an equivalent managed spelling: %s", (input, roots) => {
    expect(invalidateUngroundedMediaPrefixes(input, grounding(roots))).toContain(REDACTED);
  });

  it.each([
    // Escapes above the root, so it names something else.
    "/managed/state/../etc/passwd",
    // A longer first segment: normalization must compare whole segments, not prefixes.
    "/managed/statement/media/inbound/private.png",
    // A sibling directory whose name merely starts with the root's last segment.
    `${root}foo/inbound/private.png`,
  ])("leaves a path that does not resolve into the managed root: %s", (input) => {
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(input);
  });

  it("grounds a managed reference that follows a character whose lowercase is longer", () => {
    // U+0130 lowercases to two code units. The matcher folds the prompt for
    // case-insensitive comparison but walks it with offsets from the ORIGINAL text,
    // so an expanding character anywhere earlier used to shift every later comparison
    // and let the reference through unredacted.
    const expanding = "\u0130";
    expect(expanding.toLowerCase().length).toBe(2);
    const input = `${expanding} ${root}/secret.png`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root], [], true))).toBe(
      `${expanding} ${REDACTED}/secret.png`,
    );
  });

  it("keeps an authorized reference intact behind the same expanding character", () => {
    const expanding = "\u0130";
    const authorized = `${root}/kept.png`;
    const input = `${expanding}${expanding} ${authorized}`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root], [authorized], true))).toBe(
      input,
    );
  });
});

describe("prepareManagedMediaGrounding", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("keeps path matching exact when the real managed root has no togglable letter", async () => {
    const stateDir = tempDirs.make("grounding-mount-root-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mountRoot = path.parse(process.cwd()).root;
    fs.symlinkSync(
      mountRoot,
      path.join(stateDir, "media"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(path.basename(mountRoot)).not.toMatch(/[a-z]/i);
    await expect(prepareManagedMediaGroundingRoot()).resolves.toMatchObject({
      caseInsensitivePaths: false,
    });
  });

  it("pins regular files and emits bounded raw, URL, encoded, and macOS root aliases", async () => {
    const stateDir = path.join(tempDirs.make("grounding-aliases-"), "state dir");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "real image.png");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");

    const fileUrl = pathToFileURL(real).href;
    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, [
      fileUrl,
      `${fileUrl}?download=1`,
      `${fileUrl}#preview`,
      fileUrl.replace("real%20image", "real%2Fimage"),
      fileUrl.replace("file://", "file://attacker"),
    ]);

    expect(prepared.authorizedAliases).toContain(real);
    expect(prepared.authorizedAliases).toContain(fileUrl);
    expect(prepared.authorizedAliases).not.toEqual(
      expect.arrayContaining([
        `${fileUrl}?download=1`,
        `${fileUrl}#preview`,
        fileUrl.replace("real%20image", "real%2Fimage"),
        fileUrl.replace("file://", "file://attacker"),
      ]),
    );
    const mediaDir = path.join(stateDir, "media");
    const rootReal = fs.realpathSync(mediaDir);
    const rootBase = path.basename(rootReal);
    const letterIndex = rootBase.search(/[a-z]/i);
    const letter = rootBase.charAt(letterIndex);
    const toggledRoot = path.join(
      path.dirname(rootReal),
      `${rootBase.slice(0, letterIndex)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${rootBase.slice(letterIndex + 1)}`,
    );
    const actualCaseInsensitive = (() => {
      try {
        const original = fs.statSync(rootReal);
        const alias = fs.statSync(toggledRoot);
        return original.dev === alias.dev && original.ino === alias.ino;
      } catch {
        return false;
      }
    })();
    expect(prepared.caseInsensitivePaths).toBe(actualCaseInsensitive);
    const pathname = pathToFileURL(mediaDir).pathname;
    expect(prepared.rootAliases).toEqual(
      expect.arrayContaining([
        mediaDir,
        `file:${pathname.slice(1)}`,
        `file://${pathname}`,
        `file:///${pathname}`,
        `file://localhost${pathname}`,
        `file://localhost/${pathname}`,
      ]),
    );
    if (process.platform === "win32") {
      const slashRoot = rootReal.replaceAll("\\", "/");
      expect(prepared.rootAliases).toEqual(
        expect.arrayContaining([
          slashRoot,
          `//?/${slashRoot}`,
          `\\\\?\\${slashRoot.replaceAll("/", "\\")}`,
          pathToFileURL(rootReal).href,
        ]),
      );
      expect(prepared.rootAliases.some((alias) => alias.includes("C%3A"))).toBe(false);
    }
    const relativeFileUrl = `file:${pathToFileURL(real).pathname.slice(1)}`;
    expect(invalidateUngroundedMediaPrefixes(relativeFileUrl, prepared)).toBe(relativeFileUrl);
    expect(invalidateUngroundedMediaPrefixes(`file:${pathname.slice(1)}/fake.png`, prepared)).toBe(
      `${REDACTED}/fake.png`,
    );
    expect(prepared.authorizedAliases.length).toBeLessThanOrEqual(64);
    expect(prepared.rootAliases.length).toBeLessThanOrEqual(64);
    expect(
      [...prepared.authorizedAliases, ...prepared.rootAliases].every(
        (item) => item.length <= 4_096,
      ),
    ).toBe(true);
  });

  it("rejects missing files, directories, leaf symlinks, and intermediate symlink escapes", async () => {
    const stateDir = tempDirs.make("grounding-store-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mediaDir = path.join(stateDir, "media");
    const real = path.join(mediaDir, "real.jpg");
    const directory = path.join(mediaDir, "directory");
    const leafLink = path.join(mediaDir, "leaf.jpg");
    const outside = tempDirs.make("grounding-outside-");
    const outsideFile = path.join(outside, "secret.jpg");
    const directoryLink = path.join(mediaDir, "outside");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(real, "image");
    fs.mkdirSync(directory);
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(real, leafLink);
    fs.symlinkSync(outside, directoryLink);

    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, [
      real,
      path.join(mediaDir, "missing.jpg"),
      directory,
      leafLink,
      path.join(directoryLink, "secret.jpg"),
    ]);

    expect(prepared.authorizedAliases).toContain(real);
    expect(prepared.authorizedAliases).not.toContain(directory);
    expect(prepared.authorizedAliases).not.toContain(leafLink);
    expect(prepared.authorizedAliases).not.toContain(path.join(directoryLink, "secret.jpg"));
  });

  it("retains all 64 trusted paths independently of the derived alias cap", async () => {
    const stateDir = tempDirs.make("grounding-path-cap-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mediaDir = path.join(stateDir, "media", "generated");
    fs.mkdirSync(mediaDir, { recursive: true });
    const paths = Array.from({ length: 64 }, (_, index) => path.join(mediaDir, `${index}.png`));
    for (const filePath of paths) {
      fs.writeFileSync(filePath, "image");
    }

    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, paths);

    expect(prepared.authorizedAliases).toEqual(expect.arrayContaining(paths));
  });
});
