import path from "node:path";
import type { ManagedMediaGrounding } from "../../media/media-reference.js";

const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

const TOKEN_BOUNDARY = /[\s"'`<>{}()[\]]/u;
const PUNCTUATION = /[.,;:!?\u2012-\u2015\u2026]/u;
const REMOTE_URI = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/iu;
// A URI scheme and authority are case-insensitive: FILE:///x, file://LOCALHOST/x and
// MEDIA://inbound/x all resolve. Only the path bytes after them follow the owner's rules.
// A managed path is a handful of segments; this only bounds pathological tokens so the
// normalization walk cannot be turned into a denial of service by a long crafted string.
const MAX_NORMALIZED_SEGMENTS = 64;
// Bounds the phase-2 token scan; longer than any real managed path, short enough that a
// crafted run of non-boundary bytes cannot make the walk expensive.
const MAX_GROUNDING_TOKEN_CHARS = 4096;
// A token that begins at a managed root but exhausts the normalization budget is redacted
// rather than replayed. A real managed path never needs this many segments; an adversarial
// one does, and failing open here is what the budget itself would otherwise enable.
// Bounds how many times one token may be folded against a root it could plausibly name.
// Reached only by crafted input, and refusing to decide redacts rather than rescanning.
const MAX_PHASE2_WALKS_PER_TOKEN = 32;
const UNDECIDABLE_PREFIX = -1;
// A non-ASCII root segment has NFC and NFD spellings APFS folds; see canonicalForCompare.
const NON_ASCII = /[^\u0020-\u007e]/u;
const URI_PREFIX = /^[a-z][a-z0-9+.-]*:(?:\/\/[^/]*)?/iu;

function endsReference(text: string, end: number): boolean {
  let cursor = end;
  let char = text.charAt(cursor);
  if (!char || TOKEN_BOUNDARY.test(char)) {
    return true;
  }
  if (!PUNCTUATION.test(char)) {
    return false;
  }
  while (PUNCTUATION.test((char = text.charAt(++cursor)))) {}
  return !char || TOKEN_BOUNDARY.test(char);
}

/**
 * Lowercase without changing length. `String.prototype.toLowerCase` can expand a
 * character (U+0130 becomes two code units), and the matcher below indexes the folded
 * text with offsets taken from the ORIGINAL text. One expanding character anywhere
 * earlier in a prompt would shift every later comparison and silently stop grounding
 * from matching at all. Characters whose lowercase is not the same length keep their
 * original form, so the fold is length-preserving by construction.
 */
function foldCasePreservingLength(value: string): string {
  let folded = "";
  for (const char of value) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/**
 * Length of the raw prefix of `token` whose lexical normalization equals `root`, or 0
 * when the token never resolves into the root.
 *
 * The matcher below compares alias spellings literally, and the media resolver
 * canonicalizes before it resolves. Any spelling the resolver folds away and the matcher
 * does not is a replay bypass: `/state/./media/x` and `/state/a/../media/x` both name a
 * file under `/state/media` while matching no alias. Enumerating those spellings cannot
 * terminate, so equivalence is decided here instead.
 *
 * Lexical only. Never touches the filesystem: this runs on every replayed prompt, and a
 * symlink read per candidate would be both a hot-path cost and a new I/O dependency.
 * Symlinked spellings stay the alias preparer's job, which resolves the real path once.
 */
/**
 * A root the platform parsers can fold tokens against.
 *
 * `path` is the root's own path put through the SAME parser the candidate tokens go
 * through, so the comparison is parser-output to parser-output and never a raw spelling.
 */
type NormalizableRoot = {
  /** Parsed scheme and authority for a URI root; null for a filesystem root. */
  uri: { protocol: string; host: string } | null;
  /** Length of the raw scheme+authority text, so offsets stay in token coordinates. */
  prefixLength: number;
  path: string;
  /** Conservative gate: folding removes segments, it never invents a segment NAME. */
  lastSegment: string;
  lowerLastSegment: string;
  lowerSegments: readonly string[];
  /** Whole path, not just the last segment: ANY accented segment needs the fold to decide. */
  pathIsAscii: boolean;
  lowerPrefix: string;
};

/** A path normalized by the platform, with no trailing separator except at the root. */
function normalizedFilesystemPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Length of the raw prefix of `token` that the platform folds onto `root`, 0 when no prefix
 * does, or UNDECIDABLE_PREFIX when the spelling cannot be decided here.
 *
 * Equivalence is decided by the parsers the resolver itself uses - WHATWG `URL` for a URI
 * root, `path.posix.normalize` for a filesystem root - rather than by a fold written here.
 * Four consecutive review rounds each found a spelling a hand-written walk missed (`./root`,
 * `../root`, `//root`, `root2/../root`, `x/../root`, `%2e/root`) and a fix for one round's
 * spelling opened the next round's. Every one of them folds correctly in the parser, so the
 * class is closed by delegating rather than by enumerating spellings.
 *
 * The SHORTEST prefix that folds onto the root is the reference, so the bytes after it stay
 * the caller's to preserve.
 *
 * Lexical only. Never touches the filesystem: this runs on every replayed prompt, and a
 * symlink read per candidate would be both a hot-path cost and a new I/O dependency.
 * Symlinked spellings stay the alias preparer's job, which resolves the real path once.
 */
/**
 * Unicode canonical form for COMPARISON only.
 *
 * APFS folds NFC and NFD spellings to one file, so "café" precomposed and "cafe" + combining
 * acute name the same managed directory while comparing unequal byte-for-byte. Normalizing
 * changes length, so it can never touch the text being scanned - offsets into the transcript
 * have to stay exact. Both sides of the comparison are derived strings, so it is safe here.
 * Found by claude-air-opus5-477349 against the pre-phase-2 matcher; it reproduced here.
 */
function canonicalForCompare(value: string): string {
  return value.normalize("NFC");
}

function resolvedManagedPrefix(
  token: string,
  root: NormalizableRoot,
  comparable: (value: string) => string,
): number {
  let boundaries = 0;
  for (let end = root.prefixLength + 1; end <= token.length; end += 1) {
    const char = token.charAt(end);
    if (end !== token.length && char !== "/" && char !== "\\") {
      continue;
    }
    boundaries += 1;
    // A managed path is a handful of segments. Past the cap the token is adversarial rather
    // than a reference, and refusing to decide redacts it instead of replaying it.
    if (boundaries > MAX_NORMALIZED_SEGMENTS) {
      return UNDECIDABLE_PREFIX;
    }
    const candidate = token.slice(0, end);
    let resolved: string;
    if (root.uri) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue;
      }
      // The parser lowercases scheme and host for special schemes and preserves them for the
      // rest, which is exactly the resolver's own rule; comparing the parsed fields inherits
      // it instead of restating it.
      if (url.protocol !== root.uri.protocol || url.host !== root.uri.host) {
        continue;
      }
      // WHATWG percent-encodes every non-ASCII code point in `pathname` and folds only %2e,
      // so the parsed path is not yet comparable with a filesystem root. Both sides are
      // decoded exactly once - here and at setup - so one comparison decides every spelling.
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        // A malformed escape names nothing the owner's own decode could open either, so it
        // does not resolve into the root. Refusing here redacted ordinary transcript URLs
        // like file:///docs/100%_done.pdf whole.
        continue;
      }
      resolved = normalizedFilesystemPath(decodedPath);
    } else {
      resolved = normalizedFilesystemPath(candidate);
    }
    if (canonicalForCompare(comparable(resolved)) === canonicalForCompare(comparable(root.path))) {
      return end;
    }
    // Candidates are cut at RAW separators, but decoding turns %2F into one. A token spelling
    // its separator that way has no raw cut at the end of the root, so equality can never be
    // reached even though the decoded path lands under it. The exact prefix is unknowable
    // here, so refuse the token rather than replay it.
    if (
      root.uri &&
      canonicalForCompare(comparable(resolved)).startsWith(
        `${canonicalForCompare(comparable(root.path))}/`,
      )
    ) {
      return UNDECIDABLE_PREFIX;
    }
  }
  return 0;
}

export function invalidateUngroundedMediaPrefixes(
  text: string,
  grounding: ManagedMediaGrounding,
): string {
  if (!text || (grounding.rootAliases.length === 0 && grounding.uriRoots.length === 0)) {
    return text;
  }
  let cursor = 0,
    tokenStart = 0;
  const output: string[] = [];
  const comparisonText = grounding.caseInsensitivePaths ? foldCasePreservingLength(text) : text;
  const comparable = (alias: string) =>
    grounding.caseInsensitivePaths ? foldCasePreservingLength(alias) : alias;
  const lowercaseText = grounding.caseInsensitivePaths
    ? comparisonText
    : foldCasePreservingLength(text);
  type AliasCandidate = { alias: string; lower: string; split?: { prefix: string; rest: string } };
  const candidates = (aliases: readonly string[]): AliasCandidate[] =>
    aliases.map((alias) => ({ alias, lower: foldCasePreservingLength(alias) }));
  const rootCandidates = candidates(grounding.rootAliases);
  const uriRootCandidates = candidates(grounding.uriRoots);
  const authorizedCandidates = candidates(grounding.authorizedAliases);
  // Only plain filesystem spellings are normalized. A file:// or UNC root carries its own
  // escaping rules, and folding dot segments inside those is a separate contract; those
  // keep the literal alias match above.
  // Plain filesystem roots normalize whole. A file:// root normalizes only after its
  // scheme and authority, because WHATWG URL folds dot segments in the PATH exactly like
  // path normalization does: file:///managed/state/./media resolves into the managed root
  // just as the bare path does, so excluding URI roots here would leave the same bypass
  // reachable through a different spelling.
  const normalizableRoots: NormalizableRoot[] = grounding.rootAliases
    .concat(grounding.uriRoots)
    .map((alias) => {
      const prefix = URI_PREFIX.exec(alias)?.[0] ?? "";
      if (prefix) {
        let url: URL;
        try {
          url = new URL(alias);
        } catch {
          return null;
        }
        let decodedRootPath: string;
        try {
          decodedRootPath = decodeURIComponent(url.pathname);
        } catch {
          return null;
        }
        const rootPath = normalizedFilesystemPath(decodedRootPath);
        return {
          uri: { protocol: url.protocol, host: url.host },
          prefixLength: url.protocol.length,
          path: rootPath,
          lastSegment: rootPath.split("/").pop() ?? "",
          lowerLastSegment: foldCasePreservingLength(rootPath.split("/").pop() ?? ""),
          lowerSegments: rootPath
            .split("/")
            .filter(Boolean)
            .map((segment) => foldCasePreservingLength(segment)),
          // Scheme only. WHATWG folds empty host, "localhost" and "LOCALHOST" to the same
          // file: authority, so gating on the raw authority text rejected spellings the
          // parser resolves into the root - the exact mistake this gate must never make.
          pathIsAscii: !NON_ASCII.test(rootPath),
          lowerPrefix: foldCasePreservingLength(url.protocol),
        };
      }
      if (!/^[/\\]/u.test(alias) && !/^[a-z]:[/\\]/iu.test(alias)) {
        return null;
      }
      const rootPath = normalizedFilesystemPath(alias);
      return {
        uri: null,
        prefixLength: 0,
        path: rootPath,
        lastSegment: rootPath.split("/").pop() ?? "",
        lowerLastSegment: foldCasePreservingLength(rootPath.split("/").pop() ?? ""),
        lowerSegments: rootPath
          .split("/")
          .filter(Boolean)
          .map((segment) => foldCasePreservingLength(segment)),
        pathIsAscii: !NON_ASCII.test(rootPath),
        lowerPrefix: "",
      };
    })
    .filter((entry) => entry !== null)
    // Drops a URI root with no path of its own: "media://inbound" normalizes to ".". A
    // drive-letter root does NOT need an arm here - URI_PREFIX matches "C:" as a scheme, so
    // it takes the branch above and its pathname already starts with "/".
    .filter(({ path: rootPath, lastSegment }) => rootPath.startsWith("/") && lastSegment !== "");
  // Conservative gate, and conservative is the whole point: it may admit a token the parser
  // then rejects, but it must never reject one the parser would fold onto a root. Every
  // bypass found in rounds 5 through 8 was a prefilter that decided a token was uninteresting
  // before the fold could look at it. Folding deletes segments and never invents a segment
  // NAME, so a token that cannot fold onto the root unless it spells the root's last segment
  // - or hides it behind an escape - is safe to skip.
  // indexOf would scan to the end of the PROMPT, not the end of the token, so a prompt of
  // many one-character absolute tokens ("/ " repeated) paid two full-text scans each. Reads
  // in place: a prompt with no managed root must not spend a single String.slice.
  const containsWithin = (needle: string, at: number, end: number): boolean => {
    const limit = end - needle.length;
    for (let scan = at; scan <= limit; scan += 1) {
      if (lowercaseText.startsWith(needle, scan)) {
        return true;
      }
    }
    return false;
  };
  // Memoized per token: whether the token could still name this root does not depend on WHICH
  // position inside it is being tried, and recomputing per position is what made the scan
  // quadratic. Searching the token's whole extent admits at least as much as searching from
  // `at`, and this gate must only ever over-admit.
  let admitMemo: (boolean | undefined)[] = [];
  const admitsToken = (root: NormalizableRoot, rootIndex: number): boolean => {
    const cached = admitMemo[rootIndex];
    if (cached !== undefined) {
      return cached;
    }
    // The segment scan is byte-literal, so it cannot see across an NFC/NFD difference in
    // EITHER direction: an NFD token against an NFC root, or an NFC token against an NFD root.
    // Screening on the token's own form got the first and missed the second. Any root path
    // that is not plain ASCII simply goes to the fold, which compares canonical forms - keyed
    // on the LAST segment alone this missed "/managed/etat/media", where the accent sits in a
    // middle segment and the last one is ASCII.
    // EVERY root segment must appear literally, not just the last one. Folding deletes
    // segments and never invents a segment NAME, so this cannot reject a token the parser
    // would fold onto the root - and it is what keeps ordinary content away from the caps
    // below. Matching on the last segment alone admitted any absolute-path list containing
    // the word "media", and a 41-entry PATH then lost its tail to a cost cap.
    const admitted =
      !root.pathIsAscii ||
      containsWithin("%", cachedTokenStart, cachedTokenEnd) ||
      root.lowerSegments.every((segment) =>
        containsWithin(segment, cachedTokenStart, cachedTokenEnd),
      );
    admitMemo[rootIndex] = admitted;
    return admitted;
  };
  const matchesAt = (candidate: AliasCandidate, at: number): boolean => {
    // An all-lowercase match is necessary for any match, and costs one startsWith. Splitting
    // scheme from path is deferred so a prompt carrying no managed reference never pays for it.
    if (!lowercaseText.startsWith(candidate.lower, at)) {
      return false;
    }
    if (!candidate.split) {
      const prefix = URI_PREFIX.exec(candidate.alias)?.[0] ?? "";
      candidate.split = {
        prefix: foldCasePreservingLength(prefix),
        rest: comparable(candidate.alias.slice(prefix.length)),
      };
    }
    const { prefix, rest } = candidate.split;
    return comparisonText.startsWith(rest, at + prefix.length);
  };
  // Phase 2: a managed path spelled with dot segments matches no alias but still names a
  // file under the root. Only attempted where the text already begins a root's first
  // segment, so prose pays one startsWith per position and nothing else.
  // Returns how much to redact, and whether the walk could not decide. Undecidable means
  // the token BEGINS at a managed root and could not be proven safe, so it is redacted
  // whole and skips the trailing-boundary check: every truncation or budget exhaustion
  // must fail closed, or the caps meant to bound cost become the bypass.
  // Computed once per token: re-scanning it per position is what made a single long token
  // cost O(N^2) twice over (200k separators = 119s, a URI token plus 100k dot segments = 178s).
  let cachedTokenStart = -1;
  let cachedTokenEnd = -1;
  let phase2Walks = 0;
  let cachedRemoteUriEnd: number | undefined;
  const tokenEndFrom = (start: number): number => {
    if (start === cachedTokenStart) {
      return cachedTokenEnd;
    }
    let end = start;
    while (end < text.length && !TOKEN_BOUNDARY.test(text.charAt(end))) {
      end += 1;
    }
    cachedTokenStart = start;
    cachedTokenEnd = end;
    phase2Walks = 0;
    admitMemo = [];
    cachedRemoteUriEnd = undefined;
    return end;
  };
  // A redaction jump can carry the cursor past a boundary INSIDE a matched alias - user
  // directories contain spaces - and the memo above is keyed on a tokenStart that no longer
  // describes where the cursor is. Left stale, the token extent can end up behind the cursor
  // and the walk cap hands back a negative length, which moves the cursor BACKWARD and emits
  // text twice. Every jump re-anchors instead.
  const reanchorToken = (at: number) => {
    tokenStart = at;
    cachedTokenStart = -1;
  };
  const startsAbsolutePath = (at: number): boolean => {
    const first = text.charAt(at);
    if (first === "/" || first === "\\") {
      return true;
    }
    const second = text.charAt(at + 1);
    const third = text.charAt(at + 2);
    return /[a-z]/iu.test(first) && second === ":" && (third === "/" || third === "\\");
  };
  // KNOWN GAP, and it is wider than a root's own spelling. The fold is confined to one token,
  // so any token boundary reaching a managed path defeats it - including one an author puts
  // INSIDE a segment that normalization then discards:
  //
  //   /managed/state/x y/../media/x.png   splits at the space; "x y/.." folds away for the
  //                                       resolver, so it names the root and is replayed here
  //   C:/Users/John Doe/.openclaw/./media literal spelling is caught, dot-segment one is not
  //
  // Widening the extent is a change to the token model, not to this walk - the boundary set
  // is what keeps the matcher from running across prose - so it is a named follow-up. Stated
  // here in full because the narrower version of this comment read as if only exotic root
  // spellings were affected.
  const equivalentRootMatch = (at: number): { length: number; undecidable: boolean } | null => {
    if (normalizableRoots.length === 0) {
      return null;
    }
    const end = tokenEndFrom(tokenStart);
    if (end <= at) {
      return null;
    }
    for (const [rootIndex, root] of normalizableRoots.entries()) {
      // Every gate below reads the text in place. A prompt carrying no managed root must not
      // pay a single String.slice, which is what the rescan guard measures.
      if (root.lowerPrefix && !lowercaseText.startsWith(root.lowerPrefix, at)) {
        continue;
      }
      if (!root.uri && !startsAbsolutePath(at)) {
        continue;
      }
      if (!admitsToken(root, rootIndex)) {
        continue;
      }
      // Counted here, NOT at entry: a cap applied before the gates redacted the tail of any
      // token with enough colons in it - "tokio::sync::mpsc::error::SendError::Full" and a
      // 10-entry PATH both lost text. Only a token a root has already claimed can be refused.
      phase2Walks += 1;
      if (phase2Walks > MAX_PHASE2_WALKS_PER_TOKEN) {
        return { length: end - at, undecidable: true };
      }
      // Only a token that could still name THIS root is worth refusing. Bailing on length
      // before the gate redacted any long token, so a 200k run of "x" lost its own text.
      // A token longer than any real managed path is refused rather than truncated: scanning
      // a prefix and reporting "root not reached" replayed ./-padding that ran past the cap.
      if (end - at > MAX_GROUNDING_TOKEN_CHARS) {
        return { length: end - at, undecidable: true };
      }
      const length = resolvedManagedPrefix(text.slice(at, end), root, comparable);
      if (length === UNDECIDABLE_PREFIX) {
        return { length: end - at, undecidable: true };
      }
      if (length > 0) {
        return { length, undecidable: false };
      }
    }
    return null;
  };
  const advanceOne = () => {
    const char = text.charAt(cursor++);
    output.push(char);
    tokenStart = TOKEN_BOUNDARY.test(char) ? cursor : tokenStart;
  };
  // The guard asks whether a remote authority appears BEFORE the cursor, and the prefix only
  // grows within a token, so the answer flips exactly once - at the end of the earliest match.
  // Finding that threshold costs one scan per token; re-running the unanchored regex over the
  // prefix at every post-cap position cost O(N*M), 24s on a long scheme-like run.
  const inRemoteUri = () => {
    // tokenEndFrom FIRST: it is what notices a token change and drops the memo. Reading the
    // memo before calling it compared this cursor against the PREVIOUS token's offset, and
    // since the cursor only grows the guard read true - so one URL token anywhere ahead of a
    // managed path suppressed that path's redaction entirely.
    const end = tokenEndFrom(tokenStart);
    if (cachedRemoteUriEnd === undefined) {
      const match = REMOTE_URI.exec(text.slice(tokenStart, end));
      cachedRemoteUriEnd = match
        ? tokenStart + match.index + match[0].length
        : Number.MAX_SAFE_INTEGER;
    }
    return cursor >= cachedRemoteUriEnd;
  };
  while (cursor < text.length) {
    const literalRoot =
      rootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias ??
      uriRootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias;
    // A literal hit that fails its own trailing-boundary check must NOT end the attempt:
    // /managed/state/media2/../media/x matches the root literally, fails the boundary on
    // "2", and still resolves back into the root. Short-circuiting there replayed it.
    const literalFits =
      literalRoot !== undefined &&
      !/[\w/\\]/u.test(text.charAt(cursor - 1)) &&
      (["", "/", "\\"].includes(text.charAt(cursor + literalRoot.length)) ||
        endsReference(text, cursor + literalRoot.length));
    let rootLength = 0;
    let undecidable = false;
    if (literalFits && literalRoot !== undefined) {
      rootLength = literalRoot.length;
    } else if (!/[\w/\\]/u.test(text.charAt(cursor - 1))) {
      // Exactly the literal matcher's predecessor test. Anything narrower left a spelling the
      // literal path redacts and the fold does not: "../managed/state/./media/x" after ".",
      // "foo,/managed/state/./media/x" after ",". Cost is bounded by the per-token walk cap
      // above, not by narrowing this test.
      // Phase 2 decides a TOKEN, once. Re-entering inside one re-ran an O(N) token scan per
      // position: 200k separators cost 119s, and a URI token followed by 100k "/." segments
      // cost 178s. A reference always begins a token, so one attempt per token loses nothing.
      const match = equivalentRootMatch(cursor);
      if (match) {
        rootLength = match.length;
        undecidable = match.undecidable;
      }
    }
    if (rootLength === 0 || inRemoteUri()) {
      advanceOne();
      continue;
    }
    if (
      !undecidable &&
      !["", "/", "\\"].includes(text.charAt(cursor + rootLength)) &&
      !endsReference(text, cursor + rootLength)
    ) {
      advanceOne();
      continue;
    }
    const allowed = authorizedCandidates.find(
      (candidate) =>
        matchesAt(candidate, cursor) && endsReference(text, cursor + candidate.alias.length),
    )?.alias;
    if (allowed) {
      output.push(text.slice(cursor, cursor + allowed.length));
      cursor += allowed.length;
      reanchorToken(cursor);
    } else {
      // A dot-segment spelling of an AUTHORIZED reference is redacted too: authorized
      // aliases are the exact spellings the resolver verified, and re-deriving
      // equivalence for them would decide authorization from prompt text. Failing closed
      // costs a visible placeholder on an exotic spelling; failing open replays an
      // unverified path.
      output.push(UNGROUNDED_MEDIA_PLACEHOLDER);
      cursor += rootLength;
      reanchorToken(cursor);
    }
  }
  return output.join("");
}
