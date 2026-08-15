/* ------------------------------------------------------------------ *
 * The macOS shell.
 *
 * A WKWebView, a native menu, a status item, one global chord, and a
 * loopback HTTP server handing out the Astro build from inside the
 * bundle. No Rust, no npm dependency, no bundled engine: WKWebView is
 * the engine every Safari visitor already runs the live site against,
 * so this shell adds a window and takes no rendering risk.
 *
 * The reason it exists is the keyboard. `App.tsx` binds ⌘D ⌘E ⌘Y ⌘L
 * ⌘N ⌘P ⌘B ⌘, ⌘Z, and a browser resolves six of those before the page
 * ever sees them — two of which (⌘N, ⌘L) cannot be taken back with
 * `preventDefault` at all. A Cocoa window offers a ⌘-chord to the menu
 * bar first and to the first responder second, so every key this menu
 * declines to claim lands in the webview and reaches `useHotkeys`.
 * That is why the menus below are so short: what is *missing* from
 * them is the feature.
 *
 * Three things it gives the page that no browser will, all of them
 * measured absences rather than guesses — `Notification`
 * (`requestPermission()` answers `denied` in a WKWebView),
 * `navigator.vibrate` (undefined, so the dial's detents had no haptic
 * channel at all) and the File System Access API (undefined, which is
 * the mirror file the MCP server reads). Each is a shim in `BRIDGE_JS`
 * over one native capability, and none of them is logic: the page
 * still decides what a reminder says, when a detent taps and what a
 * mirror file contains.
 *
 * What it is not: a second product (the website is the product; this
 * serves its own build byte for byte) and a place for domain code. If
 * something here starts wanting to know what an event is, it belongs
 * in `src/lib/`.
 * ------------------------------------------------------------------ */

import AppKit
import Carbon.HIToolbox
import Darwin
import Foundation
import UserNotifications
import WebKit

/* ------------------------------- the port ------------------------------- */

/**
 * Fixed, and it has to be: `localStorage` is keyed by origin and an origin
 * includes its port, so an ephemeral port would hand the app a brand-new empty
 * store on every launch — every event the user wrote still on disk, under a
 * number nothing will ever ask for again. Below 49152 so the kernel cannot
 * hand it to somebody else's outbound connection, and unassigned by IANA.
 *
 * `LSMultipleInstancesProhibited` in `Info.plist` is the other half: two
 * copies of the app would race for this socket, and the loser has no calendar.
 */
private let PORT: UInt16 = 47531

/** Loopback, never `0.0.0.0`. Bound to any interface this would put the
 *  user's calendar on the local network and ask the firewall about it. */
private let HOST = "127.0.0.1"

/**
 * ⌥⌘C summons the window with the palette open, from any app.
 *
 * Not ⌘Space's neighbourhood and not a single modifier: this is registered
 * process-wide, so a chord anything else plausibly wants is a chord this app
 * steals. ⌥⌘C is free on a stock system, and `C` is the one letter the app is
 * named after — the palette is where a quick-add line goes, which is the whole
 * reason to summon anything.
 */
private let HOTKEY_CODE = UInt32(kVK_ANSI_C)
private let HOTKEY_MODS = UInt32(cmdKey | optionKey)

/* ------------------------------ the server ------------------------------ */

private let FEED_TIMEOUT: TimeInterval = 10
private let MAX_FEED_BYTES = 5 * 1024 * 1024
private let MAX_HEAD_BYTES = 16 * 1024

enum ServerError: Error {
    case bind(String)
}

/**
 * A blocking, thread-per-connection HTTP/1.1 server over BSD sockets, which is
 * the boring choice on purpose: it serves about twenty files once per launch
 * (the service worker takes over after that) and it has no asynchrony for a
 * bug to hide in. `Connection: close` every time for the same reason.
 */
final class LocalServer {
    private let root: URL
    private let fd: Int32

    init(root: URL) throws {
        self.root = root.standardizedFileURL
        fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ServerError.bind("socket() failed") }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = PORT.bigEndian
        addr.sin_addr.s_addr = inet_addr(HOST)

        var bound: Int32 = -1
        withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bound = Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else {
            close(fd)
            throw ServerError.bind("port \(PORT) is already in use")
        }
        guard listen(fd, 32) == 0 else {
            close(fd)
            throw ServerError.bind("listen() failed")
        }
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    break
                }
                Thread.detachNewThread { [self] in
                    serve(client)
                    close(client)
                }
            }
        }
    }

    private func serve(_ client: Int32) {
        guard let head = readHead(client), let line = head.split(separator: "\r\n").first else {
            return
        }
        let parts = line.split(separator: " ")
        guard parts.count >= 2 else { return send(client, "400 Bad Request", body: "bad request") }

        let method = String(parts[0])
        guard method == "GET" || method == "HEAD" else {
            return send(client, "405 Method Not Allowed", body: "method not allowed")
        }
        let headOnly = method == "HEAD"
        let components = URLComponents(string: "http://\(HOST):\(PORT)" + parts[1])
        let path = components?.path ?? "/"

        if path == "/api/feed" {
            let target = components?.queryItems?.first(where: { $0.name == "url" })?.value
            let (status, type, body) = proxyFeed(target)
            return send(client, status, type: type, data: body, headOnly: headOnly)
        }

        if let (data, type) = file(at: path) {
            return send(client, "200 OK", type: type, data: data, headOnly: headOnly)
        }
        if let (data, type) = file(at: "/404.html") {
            return send(client, "404 Not Found", type: type, data: data, headOnly: headOnly)
        }
        send(client, "404 Not Found", body: "not found", headOnly: headOnly)
    }

    /* ------------------------------ static ------------------------------ */

    /**
     * `trailingSlash: "always"` is the whole subtlety here: every link the site
     * writes ends in `/`, so a path is a directory and the file under it is
     * `index.html`. The prefix check is what keeps a `..` (or a percent-encoded
     * one, which `URLComponents` has already decoded by now) inside the bundle.
     */
    private func file(at path: String) -> (Data, String)? {
        var relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if relative.isEmpty || relative.hasSuffix("/") { relative += "index.html" }

        var url = root.appendingPathComponent(relative).standardizedFileURL
        guard url.path.hasPrefix(root.path + "/") else { return nil }
        if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
            url = url.appendingPathComponent("index.html")
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (data, mime(url.pathExtension))
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/vnd.microsoft.icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "txt": return "text/plain; charset=utf-8"
        case "xml": return "application/xml; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    /* ------------------------------- feeds ------------------------------- */

    /**
     * `/api/feed`, the Worker's one route, reimplemented in eleven lines of
     * `URLSession` — because native HTTP has no CORS and the proxy only ever
     * existed to borrow an origin. `lib/feeds.ts` is untouched and does not
     * know it is talking to a different machine.
     *
     * The SSRF guard comes with it. Loopback matters *more* here than on the
     * Worker, not less: a pasted feed URL naming `127.0.0.1` would reach this
     * app's own server, and everything else listening on the user's machine.
     */
    private func proxyFeed(_ raw: String?) -> (String, String, Data) {
        let plain = "text/plain; charset=utf-8"
        guard let raw, let target = URL(string: raw), let scheme = target.scheme?.lowercased(),
            scheme == "http" || scheme == "https", let host = target.host
        else {
            return ("400 Bad Request", plain, Data("Not a fetchable URL".utf8))
        }
        if let reason = blockReason(host) {
            return ("400 Bad Request", plain, Data(reason.utf8))
        }

        let session = URLSession(
            configuration: .ephemeral,
            delegate: RedirectGuard(),
            delegateQueue: nil
        )
        var request = URLRequest(url: target, timeoutInterval: FEED_TIMEOUT)
        request.setValue("text/calendar, text/plain;q=0.9, */*;q=0.5", forHTTPHeaderField: "Accept")

        var body: Data?
        var status = 502
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, _ in
            body = data
            if let http = response as? HTTPURLResponse { status = http.statusCode }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + FEED_TIMEOUT + 2)
        session.invalidateAndCancel()

        guard let body, status < 400 else {
            return ("502 Bad Gateway", plain, Data("Could not reach the feed".utf8))
        }
        guard body.count <= MAX_FEED_BYTES else {
            return ("413 Payload Too Large", plain, Data("Feed is too large".utf8))
        }
        // Same sniff as `looksLikeCalendar`: a login page that answers 200 is
        // the single most common thing a wrong feed URL returns, and handing it
        // to `fromIcs` produces a calendar with nothing in it and no reason.
        let text = String(decoding: body, as: UTF8.self)
        guard text.prefix(1024).uppercased().contains("BEGIN:VCALENDAR") else {
            return ("422 Unprocessable Content", plain, Data("Not a calendar feed".utf8))
        }
        return ("200 OK", "text/calendar; charset=utf-8", body)
    }

    /* ------------------------------ plumbing ----------------------------- */

    private func readHead(_ client: Int32) -> String? {
        var head = Data()
        var buffer = [UInt8](repeating: 0, count: 2048)
        while head.count < MAX_HEAD_BYTES {
            let read = Darwin.read(client, &buffer, buffer.count)
            if read <= 0 { return nil }
            head.append(contentsOf: buffer[0..<read])
            if let end = head.range(of: Data("\r\n\r\n".utf8)) {
                return String(decoding: head[..<end.lowerBound], as: UTF8.self)
            }
        }
        return nil
    }

    private func send(_ client: Int32, _ status: String, body: String, headOnly: Bool = false) {
        send(
            client,
            status,
            type: "text/plain; charset=utf-8",
            data: Data(body.utf8),
            headOnly: headOnly
        )
    }

    private func send(
        _ client: Int32,
        _ status: String,
        type: String,
        data: Data,
        headOnly: Bool = false
    ) {
        // `no-store` throughout: the service worker owns offline here exactly as
        // it does on the website, and a disk read from inside the bundle is
        // cheaper than any revalidation this could negotiate.
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(data.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n\r\n"
        writeAll(client, Data(head.utf8))
        if !headOnly { writeAll(client, data) }
    }

    private func writeAll(_ client: Int32, _ data: Data) {
        data.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(client, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if n <= 0 { return }
                sent += n
            }
        }
    }
}

/** Re-runs the guard on every hop, the reason `followChecked` in
 *  `worker/index.ts` follows redirects by hand: a public URL redirecting to
 *  `169.254.169.254` is the whole trick, and it defeats a check made once. */
private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let host = request.url?.host, blockReason(host) == nil else {
            return completionHandler(nil)
        }
        completionHandler(request)
    }
}

/** The hostname table, in the same shape and for the same reasons as
 *  `ssrfBlockReason`. Literal forms only — a name resolving into private space
 *  is DNS rebinding, which no client-side check can see. */
private func blockReason(_ hostname: String) -> String? {
    let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host.isEmpty { return "No host" }
    if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") {
        return "Local addresses are not allowed"
    }
    if host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80") {
        return "Private addresses are not allowed"
    }
    let octets = host.split(separator: ".").compactMap { UInt8($0) }
    if octets.count == 4, host.allSatisfy({ $0.isNumber || $0 == "." }) {
        switch (octets[0], octets[1]) {
        case (0, _), (127, _), (10, _), (169, 254), (192, 168):
            return "Private addresses are not allowed"
        case (172, 16...31):
            return "Private addresses are not allowed"
        default: break
        }
    }
    return nil
}

/* ---------------------------- the mirror file ---------------------------- */

enum MirrorError: Error {
    case none
    case unreadable(String)
}

/**
 * The file the MCP server reads, from the shell's side.
 *
 * A **bookmark**, not a path, and that is the difference between this and the
 * browser's handle: a bookmark follows the file when it is renamed or moved, and
 * it needs no second gesture on a later launch. `mirrorLink.ts` therefore stops
 * remembering a handle under the shell and keeps only the revision, which is the
 * one thing the file cannot tell it.
 *
 * Writes are in place — truncate and write, not write-temp-and-rename. The
 * rename would give the file a new identity on every save, which is exactly what
 * the bookmark, and any watcher the agent side has, are keyed on.
 */
final class MirrorFile {
    private let key = "mirror.bookmark"
    private let pathKey = "mirror.path"
    private var url: URL?

    /** The name to show, resolving the bookmark if this launch has not yet. */
    func remembered() -> String? {
        if let url { return url.lastPathComponent }
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: key) {
            var stale = false
            if let resolved = try? URL(
                resolvingBookmarkData: data,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            ) {
                url = resolved
                // A stale bookmark still resolved, which means the file moved
                // far enough that the old one will not survive another hop.
                if stale { store(resolved) }
                return resolved.lastPathComponent
            }
        }
        // The bookmark lost the file (deleted, or on a volume that is away).
        // The path is the weaker answer and is kept only for this case.
        if let path = defaults.string(forKey: pathKey),
            FileManager.default.fileExists(atPath: path)
        {
            let recovered = URL(fileURLWithPath: path)
            url = recovered
            store(recovered)
            return recovered.lastPathComponent
        }
        return nil
    }

    /**
     * The save panel, which is the same gesture `showSaveFilePicker` makes in a
     * browser — including its "replace?" alert on an existing file, which is
     * misleading here in a safe direction: circal **adopts** a file that already
     * holds a calendar rather than overwriting it (`mirror.connect`), because the
     * destructive direction is the one that cannot be undone.
     */
    func pick(suggestedName: String) -> String? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.message =
            "Where your calendar is mirrored. An assistant reads and writes this file; "
            + "circal keeps it in step."
        panel.prompt = "Use file"
        guard panel.runModal() == .OK, let picked = panel.url else { return nil }
        // The panel creates nothing, and a file that does not exist yet cannot
        // be bookmarked — so make it here, empty. An empty mirror is the one
        // `poll()` reads as "nothing to adopt, the next write fills it".
        if !FileManager.default.fileExists(atPath: picked.path) {
            FileManager.default.createFile(atPath: picked.path, contents: nil)
        }
        url = picked
        store(picked)
        return picked.lastPathComponent
    }

    func read() throws -> String {
        guard let url else { throw MirrorError.none }
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw MirrorError.unreadable(error.localizedDescription)
        }
    }

    func write(_ body: String) throws {
        guard let url else { throw MirrorError.none }
        do {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: Data(body.utf8))
        } catch {
            throw MirrorError.unreadable(error.localizedDescription)
        }
    }

    func forget() {
        url = nil
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: pathKey)
    }

    private func store(_ target: URL) {
        UserDefaults.standard.set(target.path, forKey: pathKey)
        guard let data = try? target.bookmarkData() else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

/* ------------------------------- the bridge ------------------------------- */

/**
 * The three capabilities the page cannot get from WebKit, and nothing else.
 *
 * `WKScriptMessageHandlerWithReply` rather than one-way `postMessage`, because
 * every one of these is a question: may I notify, what did the user pick, what
 * does the file say. A one-way channel would need a second one back and an id
 * scheme to match them up, which is a promise reimplemented by hand.
 */
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    private let mirror = MirrorFile()

    /**
     * Which of the two delivery paths this build got, remembered across launches.
     *
     * The first is `UNUserNotificationCenter`, and it works here: this ad-hoc
     * signed bundle was granted under its own name and icon (log:
     * `didGrant: 1 hasError: 0`, `Authorization set for app.circal.mac to allow:
     * YES`) and delivered a reminder with the window hidden.
     *
     * The second exists because that is not guaranteed. A bundle the system
     * declines is refused outright — `UNErrorDomain` code 1, "Notifications are
     * not allowed for this application", measured on a throwaway ad-hoc bundle,
     * via LaunchServices and directly, with a regular activation policy — and a
     * switch that turns on and then never fires is worse than one that says no.
     * So an **error** from `requestAuthorization`, never a plain refusal (that is
     * the user's answer and it stands), drops delivery onto `osascript`'s own
     * `display notification`, which an ad-hoc bundle may use (measured: exit 0,
     * no TCC prompt). It costs the banner its icon and its click, since the
     * notification then belongs to the script host rather than to circal.
     */
    private var byScript: Bool {
        get { UserDefaults.standard.bool(forKey: "notify.byScript") }
        set { UserDefaults.standard.set(newValue, forKey: "notify.byScript") }
    }

    /** What `Notification.permission` should read on a fresh load: the system's
     *  answer, or `granted` when this build has fallen back to the script path
     *  and can therefore deliver. */
    func permission(_ answer: @escaping (String) -> Void) {
        if byScript { return answer("granted") }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let granted = settings.authorizationStatus == .authorized
            DispatchQueue.main.async { answer(granted ? "granted" : "default") }
        }
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "malformed bridge message")
        }
        let arg = body["arg"] as? [String: Any] ?? [:]

        switch op {
        case "haptic":
            tap(arg["pattern"] as? [Double] ?? [0])
            replyHandler(nil, nil)

        case "notify.permission":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
                granted, error in
                DispatchQueue.main.async {
                    if granted {
                        self.byScript = false
                        return replyHandler("granted", nil)
                    }
                    // An *error* is the system refusing the application; the user
                    // was never asked, so falling back is not overriding anybody.
                    // A clean `false` is the user saying no, and that answer stands.
                    if error != nil {
                        self.byScript = true
                        return replyHandler("granted", nil)
                    }
                    replyHandler("denied", nil)
                }
            }

        case "notify.post":
            post(
                title: arg["title"] as? String ?? "",
                body: arg["body"] as? String ?? "",
                tag: arg["tag"] as? String ?? UUID().uuidString
            )
            replyHandler(nil, nil)

        case "mirror.pick":
            let suggested = arg["suggestedName"] as? String ?? "circal.json"
            replyHandler(mirror.pick(suggestedName: suggested) ?? "", nil)

        case "mirror.remembered":
            replyHandler(mirror.remembered() ?? "", nil)

        case "mirror.read":
            do { replyHandler(try mirror.read(), nil) } catch { replyHandler(nil, describe(error)) }

        case "mirror.write":
            do {
                try mirror.write(arg["body"] as? String ?? "")
                replyHandler(nil, nil)
            } catch {
                replyHandler(nil, describe(error))
            }

        case "mirror.forget":
            mirror.forget()
            replyHandler(nil, nil)

        default:
            replyHandler(nil, "unknown bridge op \(op)")
        }
    }

    /**
     * `feedback.ts` speaks `navigator.vibrate`'s pattern — on, off, on — so the
     * even elements are contacts and the odd ones are the gaps between them.
     * `.alignment` is the crispest of the three system patterns and the only one
     * that reads as a detent rather than a thud, which is what the dial's
     * fifteen-minute step is.
     */
    private func tap(_ pattern: [Double]) {
        var delay = 0.0
        for (index, value) in pattern.enumerated() {
            guard index.isMultiple(of: 2) else {
                delay += value / 1000
                continue
            }
            if delay == 0 {
                strike()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { strike() }
            }
        }
    }

    private func post(title: String, body: String, tag: String) {
        if byScript { return postByScript(title: title, body: body) }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["tag": tag]
        content.sound = .default
        // The tag as the identifier, which is what the web's own `tag` means:
        // the platform replaces a notification already showing rather than
        // stacking a second countdown for the same occurrence.
        let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            // A build that was authorised once and refused later: fall through
            // rather than swallow the one reminder the user was waiting for.
            guard error != nil else { return }
            DispatchQueue.main.async {
                self.byScript = true
                self.postByScript(title: title, body: body)
            }
        }
    }

    /**
     * The fallback, spelled with `Process` rather than `NSAppleScript` so no
     * shell parses anything and the two strings travel as argv. There is no tag
     * and no click: `display notification` has neither, which is exactly what the
     * comment on `byScript` is warning about.
     */
    private func postByScript(title: String, body: String) {
        let script =
            "display notification \(appleScriptString(body)) "
            + "with title \(appleScriptString(title)) sound name \"Ping\""
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        try? task.run()
    }

    /** An AppleScript string literal. Two escapes, and they are the only two the
     *  language has inside quotes. */
    private func appleScriptString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case MirrorError.none: return "No mirror file"
        case MirrorError.unreadable(let why): return why
        default: return error.localizedDescription
        }
    }
}

private func strike() {
    NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
}

/**
 * The page's side of the bridge, injected before its first script runs.
 *
 * Every one of these is a *shim over an absence*, not a new API: `feedback.ts`
 * already calls `navigator.vibrate`, `hooks.ts` already constructs a
 * `Notification` and reads `Notification.permission`, and `mirrorLink.ts` looks
 * for `window.__circalMirror` beside the File System Access picker it prefers.
 * So the app is unchanged on the web and gains three things in the shell,
 * without a single `if (isApp)` in a component.
 */
private let BRIDGE_JS = """
(() => {
  const post = (op, arg) =>
    window.webkit.messageHandlers.circal.postMessage({ op, arg: arg ?? null });

  Object.defineProperty(navigator, "vibrate", {
    configurable: true,
    writable: true,
    value: (pattern) => {
      void post("haptic", { pattern: Array.isArray(pattern) ? pattern : [pattern] });
      return true;
    },
  });

  let permission = "default";
  const live = new Map();

  class ShellNotification extends EventTarget {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      permission = await post("notify.permission");
      return permission;
    }
    constructor(title, options = {}) {
      super();
      this.title = title;
      this.body = options.body ?? "";
      this.tag = options.tag ?? "";
      this.onclick = null;
      live.set(this.tag, this);
      void post("notify.post", { title, body: this.body, tag: this.tag });
    }
    close() {
      live.delete(this.tag);
    }
  }

  window.Notification = ShellNotification;
  window.__circalPermission = (value) => {
    permission = value;
  };
  window.__circalNotificationClicked = (tag) => {
    const note = live.get(tag);
    if (note && typeof note.onclick === "function") note.onclick(new Event("click"));
  };

  window.__circalMirror = {
    pick: (suggestedName) => post("mirror.pick", { suggestedName }),
    remembered: () => post("mirror.remembered"),
    read: () => post("mirror.read"),
    write: (body) => post("mirror.write", { body }),
    forget: () => post("mirror.forget"),
  };

})();
"""

/* ------------------------------- the shell ------------------------------- */

/** The hotkey handler is a C function pointer and cannot capture, so the one
 *  delegate is reachable through the file instead. */
private weak var summoner: AppDelegate?

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate,
    UNUserNotificationCenterDelegate
{
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: LocalServer?
    private let bridge = Bridge()
    private var statusItem: NSStatusItem!
    private var titleWatch: NSKeyValueObservation?
    private var hotKey: EventHotKeyRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A client that hangs up mid-response raises SIGPIPE on the write, and
        // the default disposition for that is to kill the process.
        signal(SIGPIPE, SIG_IGN)
        summoner = self

        buildMenu()

        guard let root = Bundle.main.resourceURL?.appendingPathComponent("dist"),
            FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
        else {
            return die("This build has no dist/ in it. Run `pnpm build:mac`.")
        }
        do {
            let server = try LocalServer(root: root)
            server.start()
            self.server = server
        } catch ServerError.bind(let why) {
            return die("circal could not open its local port: \(why).")
        } catch {
            return die("circal could not start its local server.")
        }

        UNUserNotificationCenter.current().delegate = self
        buildWindow()
        buildStatusItem()
        installHotKey()
        webView.load(URLRequest(url: URL(string: "http://\(HOST):\(PORT)/")!))
        NSApp.activate(ignoringOtherApps: true)
    }

    /**
     * The app outlives its window on purpose. There is a status item and a
     * global chord to bring it back, and a calendar that quits when you put it
     * away cannot answer a reminder or hold a mirror file in step — the two
     * things it is most useful for while out of sight.
     */
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        show()
        return true
    }

    /* ------------------------------ window ------------------------------ */

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        // The default (persistent) store, keyed by this bundle id and the fixed
        // origin above — which is what makes `circal.v1` survive a quit.
        configuration.websiteDataStore = .default()
        // Right-click → Inspect Element. This shell has no devtools of its own
        // and a webview you cannot open is one you cannot verify.
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        configuration.userContentController.addScriptMessageHandler(
            bridge,
            contentWorld: .page,
            name: "circal"
        )
        configuration.userContentController.addUserScript(
            WKUserScript(source: BRIDGE_JS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        // Hold the first paint until there is content to paint, which is the
        // whole of the white-flash fix and is public API for exactly this.
        //
        // The first attempt was to hide the view and show it on a `painted`
        // message from the page. It cannot work, and the log says why: WebKit
        // takes a hidden view as a background one and suspends the web process
        // (`WebProcessProxy::didChangeThrottleState(Suspended)`), so the frame
        // that was being waited for is a frame that will never be drawn. Gating
        // rendering on rendering is a deadlock however it is spelled.
        configuration.suppressesIncrementalRendering = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        // The other two whites, and both are the webview's own.
        // `underPageBackgroundColor` is the over-scroll and the colour WebKit
        // paints before the page names one; `drawsBackground` (KVC, because the
        // property is not in the public header) stops it painting an opaque sheet
        // at all, so what shows through is this window's black.
        webView.underPageBackgroundColor = .black
        webView.setValue(false, forKey: "drawsBackground")
        // The app steps days through `history.pushState`, so a two-finger swipe
        // would be "yesterday" — a gesture nobody aimed, mid-drag on the dial.
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "circal"
        window.delegate = self
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
        // A transparent titlebar over a black window is a black strip with the
        // traffic lights in it. Deliberately *not* `fullSizeContentView`: the
        // lights would then sit on top of `TopBar`'s left button group, and
        // three buttons under three buttons is a bar nobody can aim at.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .disallowed
        // `DIAL` is a square face with a readout in it; below this it is the
        // chrome that breaks first, and the strip and the year ring with it.
        window.minSize = NSSize(width: 420, height: 480)
        window.contentView = webView
        window.setFrameAutosaveName("circal.window")
        // Ordered front now, black and empty: the view has to be in a visible
        // window or WebKit will not render into it at all.
        window.makeKeyAndOrderFront(nil)
    }

    /** The red button puts the window away rather than ending the session, and
     *  ⌘W is deliberately not a menu chord: in this shell it belongs to the page,
     *  where it means the week view. Nothing is lost either way — the store is
     *  written on every change — but a mirror in step and a reminder due in ten
     *  minutes both need the process, and neither is worth re-launching for. */
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    /* ---------------------------- the status item ---------------------------- */

    /**
     * The menu bar item earns its place by carrying the countdown, not by being
     * a second way to open a window.
     *
     * `useTitleCountdown` already writes `· 14m · Standup` into `document.title`
     * **while the tab is hidden**, and a window ordered out is hidden — measured.
     * So the shell observes the webview's title and prints the suffix beside the
     * ring: the reminder that survives a put-away window, with no new state, no
     * second clock and nothing asked of the page.
     */
    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = ringImage()
        statusItem.button?.imagePosition = .imageLeading

        let menu = NSMenu()
        menu.addItem(withTitle: "Open circal", action: #selector(show), keyEquivalent: "")
        let quick = menu.addItem(
            withTitle: "Quick add…",
            action: #selector(quickAdd),
            keyEquivalent: "c"
        )
        quick.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(.separator())
        menu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "")
        menu.addItem(
            withTitle: "Quit circal",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: ""
        )
        statusItem.menu = menu

        titleWatch = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            self?.showCountdown()
        }
    }

    private func showCountdown() {
        let title = webView.title ?? ""
        // The page's own suffix, or nothing. Anything before the first "·" is
        // the app's name, which the ring already says.
        guard let mark = title.range(of: "· ") else {
            statusItem.button?.title = ""
            return
        }
        statusItem.button?.title = " " + title[mark.upperBound...].trimmingCharacters(in: .whitespaces)
    }

    /** The mark: one thin circumference, the favicon at menu bar size. A
     *  template image, so the system inverts it for a light menu bar and dims
     *  it when the app is not the active one. */
    private func ringImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 2.6, dy: 2.6))
            ring.lineWidth = 1.5
            NSColor.black.setStroke()
            ring.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }

    /* ---------------------------- the global chord ---------------------------- */

    /**
     * ⌥⌘C from any app. Carbon's `RegisterEventHotKey` rather than
     * `NSEvent.addGlobalMonitorForEvents`, which needs Accessibility permission
     * — a system prompt, an entry in a privacy pane and a "why does my calendar
     * want to read my keystrokes" that this feature does not deserve. A
     * registered hot key needs none of that and cannot see any other key.
     */
    private func installHotKey() {
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, _ in
                summoner?.summon()
                return noErr
            },
            1,
            &spec,
            nil,
            nil
        )
        let status = RegisterEventHotKey(
            HOTKEY_CODE,
            HOTKEY_MODS,
            EventHotKeyID(signature: OSType(0x6369_7263), id: 1),
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
        // Somebody else registered ⌥⌘C first, which is the one way this fails
        // and is invisible: the app runs, the chord belongs to them. stderr,
        // not an alert — nothing the user has to answer, and `Console` is where
        // a missing shortcut is diagnosed.
        if status != noErr {
            FileHandle.standardError.write(
                Data("circal: ⌥⌘C is already taken (status \(status))\n".utf8)
            )
        }
    }

    /** A toggle, because a summon chord you cannot dismiss with the same fingers
     *  is a chord that leaves a window behind every time it is misfired. */
    func summon() {
        if NSApp.isActive, window.isVisible {
            hide()
            return
        }
        quickAdd()
    }

    @objc private func quickAdd() {
        show()
        // ⌘P, dispatched at the window the way a keypress arrives: `useHotkeys`
        // listens there, so the palette opens through the app's own binding
        // rather than through a second entry point that could drift from it.
        webView.evaluateJavaScript(
            "window.dispatchEvent(new KeyboardEvent('keydown',"
                + "{key:'p',metaKey:true,bubbles:true,cancelable:true}))"
        )
    }

    @objc private func show() {
        // `unhide` first, and it is not optional: `hide()` below hides the whole
        // application, and an application that is hidden stays hidden through
        // `activate(ignoringOtherApps:)` — the window is ordered front into a
        // hidden app and nothing appears. Found by driving it: ⌥⌘C did nothing
        // at all after a ⌘W.
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func hide() {
        window.orderOut(nil)
        NSApp.hide(nil)
    }

    @objc private func reload() {
        webView.reload()
    }

    /* ------------------------------- menu ------------------------------- */

    /**
     * Five short menus, and the omissions are the point. Nothing here claims
     * ⌘D ⌘E ⌘Y ⌘L ⌘B ⌘N ⇧⌘N ⌘P ⌘, ⌘Z ⇧⌘Z or ⌘⌫ — every one of those is a
     * binding in `App.tsx` or `Dial.tsx`, and a menu item wearing the same
     * chord swallows the keydown before the page is offered it. So: no File
     * menu (⌘N, ⌘P), no Settings item (⌘,), and no Undo/Redo in Edit (⌘Z),
     * whose absence hands the app's own sixty-step history the key instead.
     *
     * Cut/Copy/Paste/Select All stay, because a text field needs the responder
     * chain to be told about them and none of those four is a circal binding.
     */
    private func buildMenu() {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(
            withTitle: "About circal",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        app.addItem(.separator())
        app.addItem(
            withTitle: "Hide circal",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let others = app.addItem(
            withTitle: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(
            withTitle: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        app.addItem(.separator())
        app.addItem(
            withTitle: "Quit circal",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        main.addItem(submenu: app, titled: "circal")

        // Selectors off NSText: `cut:`, `copy:`, `paste:` and `selectAll:` are
        // declared there rather than on NSResponder, and a nil target is what
        // sends each one to whatever the first responder does with it.
        let edit = NSMenu()
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        main.addItem(submenu: edit, titled: "Edit")

        let view = NSMenu()
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        let fullScreen = view.addItem(
            withTitle: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu: view, titled: "View")

        let windows = NSMenu()
        let quick = windows.addItem(
            withTitle: "Quick add…",
            action: #selector(quickAdd),
            keyEquivalent: "c"
        )
        quick.keyEquivalentModifierMask = [.command, .option]
        windows.addItem(.separator())
        windows.addItem(
            withTitle: "Minimise",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windows.addItem(
            withTitle: "Zoom",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        windows.addItem(.separator())
        // No ⌘W on it, which is the point: in a browser that chord closes the tab
        // and the page never sees it, so the app spells the week view ⌘E — but
        // here the chord is free, `App.tsx` binds it too, and a menu item wearing
        // it would swallow the keydown before the page was offered it. "Hide", not
        // "Close", because the process stays: a menu item that says close while
        // the app carries on is a menu item that lies. ⌘H hides the whole app,
        // ⌥⌘C brings it back.
        windows.addItem(
            withTitle: "Hide Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: ""
        )
        main.addItem(submenu: windows, titled: "Window")

        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    /* ---------------------------- notifications ---------------------------- */

    /** A reminder is worth showing while the app is frontmost too: the window
     *  may be behind another app's, and the dial does not shout. */
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /** Tapping the banner does what the web build's `note.onclick` does — focus
     *  and open the event — by handing the tag back to the page that made it. */
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        show()
        let tag = response.notification.request.content.userInfo["tag"] as? String ?? ""
        webView.evaluateJavaScript("window.__circalNotificationClicked(\(jsLiteral(tag)))")
        completionHandler()
    }

    /* ---------------------------- navigation ---------------------------- */

    /** Everything the app itself does is same-origin. A link out — the
     *  manifesto's credit, a docs URL — belongs in the user's browser: this
     *  window has no address bar and nothing to come back with. */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        if navigationAction.navigationType == .linkActivated, let url,
            url.host != HOST || url.port != Int(PORT)
        {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    /** The notification shim starts every load at `"default"`, which would put
     *  the settings switch back to off in an app that can already deliver. The
     *  bridge knows which of its two paths this build is on, so it answers. */
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge.permission { state in
            webView.evaluateJavaScript("window.__circalPermission(\(jsLiteral(state)))")
        }
    }

    private func die(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "circal cannot start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

/** A JS string literal, quoted and escaped by the one thing on this side that
 *  already knows the rules. */
private func jsLiteral(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
        let array = String(data: data, encoding: .utf8), array.count >= 2
    else {
        return "\"\""
    }
    return String(array.dropFirst().dropLast())
}

extension NSMenu {
    /// A submenu needs a carrier item whose own title macOS ignores, except in
    /// the app menu where it is the one it prints. One line rather than four.
    fileprivate func addItem(submenu: NSMenu, titled title: String) {
        let item = NSMenuItem()
        item.title = title
        submenu.title = title
        item.submenu = submenu
        addItem(item)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
