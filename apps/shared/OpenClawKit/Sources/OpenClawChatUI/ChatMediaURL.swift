import Foundation

public enum OpenClawChatMediaURL {
    /// Only canonical inbound IDs may use the authenticated assistant-media route.
    public static func inboundSource(_ raw: String) -> String? {
        guard let url = URLComponents(string: raw), url.scheme == "media", url.host == "inbound",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix("/"), url.path.count > 1
        else { return nil }
        let id = String(url.path.dropFirst())
        guard id != ".", id != "..", !id.contains("/"), !id.contains("\\"),
              !id.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { return nil }
        return raw
    }

    public static func resolve(
        gatewayURL: URL,
        ticketedPath: String,
        playback: OpenClawChatPlaybackMode?) -> URL?
    {
        let prefix = "/api/chat/media/outgoing/"
        guard ticketedPath.hasPrefix(prefix),
              let relative = URLComponents(string: ticketedPath),
              relative.scheme == nil,
              relative.host == nil,
              relative.fragment == nil,
              relative.percentEncodedPath.hasPrefix(prefix),
              relative.queryItems?.contains(where: {
                  $0.name == "mediaTicket" && $0.value?.isEmpty == false
              }) == true,
              var base = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false),
              base.host != nil
        else { return nil }
        switch base.scheme?.lowercased() {
        case "wss", "https": base.scheme = "https"
        case "ws", "http": base.scheme = "http"
        default: return nil
        }
        // The Gateway returns a root-relative route, but the proxy owns its prefix.
        // Preserve encoded octets and repeated slashes just as the WebSocket does.
        let contextPath = base.percentEncodedPath == "/" ? "" : base.percentEncodedPath
        base.percentEncodedPath = contextPath + relative.percentEncodedPath
        base.percentEncodedQuery = relative.percentEncodedQuery
        base.fragment = nil
        if playback == .transcode {
            var queryItems = base.queryItems ?? []
            queryItems.removeAll { $0.name == "playback" }
            queryItems.append(URLQueryItem(name: "playback", value: "1"))
            base.queryItems = queryItems
        }
        return base.url
    }
}
