import Foundation

enum TalkStopPhrase {
    static func matches(_ text: String, phrases: [String]) -> Bool {
        let text = text.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        return phrases.contains { phrase in
            let words = phrase.precomposedStringWithCanonicalMapping.split(whereSeparator: { $0.isWhitespace })
            guard !words.isEmpty else { return false }
            // Treat preferences as literal speech, never regular expressions.
            // Whole-utterance matching preserves quoted and longer conversation.
            let literal = words.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: #"\s+"#)
            let command = #"^(?:please[\s,]+)?"# + literal + #"(?:[\s,]+please)?\s*[.!?。！？]*$"#
            return text.range(of: command, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }
}
