import CallKit
import Capacitor
import CryptoKit
import PushKit
import UIKit
import WebKit

/**
 * Incoming calls on iOS: PushKit + CallKit (31 Oct 2026).
 *
 * The app registers with PushKit at launch (AppDelegate calls CallRinging.shared.start()) and
 * the page sends the VoIP token to POST /api/push/native as platform "ios_voip"
 * (web/lib/native-bridge.ts, through this plugin's getVoipToken and "voipToken" event). A call
 * to this account arrives as a VoIP push straight from APNs (api/internal/push/apns_voip.go,
 * topic com.webinarliv.app.voip) carrying the shared call contract:
 *
 *   {"type":"incoming_call","callId","callerName","callerAvatarUrl","meetingSlug","topic","joinUrl","expiresAt"}
 *   {"type":"call_ended","callId","state"}
 *
 * iOS kills an app that does not report every VoIP push to CallKit before the push handler
 * returns, so every push is reported, at once: an incoming call rings; a call_ended, or a push
 * for a call that is already over or expired, is reported and ended in the same breath.
 *
 * Answer POSTs /api/calls/{id}/accept and End (ringing) POSTs /decline, natively, with the
 * WebView's own session cookie from WKWebsiteDataStore.default(), so they work from the lock
 * screen with the app not running. Answer hands the answer's joinUrl to the page
 * ("callAccepted", kept until the page listens) and then ends the CallKit call: the meeting
 * itself runs in the WKWebView, whose audio session WebKit owns. A call nobody answers ends
 * as unanswered at its expiresAt.
 */
@objc(CallRingingPlugin)
public class CallRingingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallRingingPlugin"
    public let jsName = "CallRinging"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVoipToken", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        CallRinging.shared.attach(self)
    }

    @objc func getVoipToken(_ call: CAPPluginCall) {
        call.resolve(["token": CallRinging.shared.voipToken ?? ""])
    }

    func emit(_ event: String, _ data: [String: Any], retain: Bool) {
        notifyListeners(event, data: data, retainUntilConsumed: retain)
    }
}

final class CallRinging: NSObject {
    static let shared = CallRinging()

    /// The site the WebView signs in to (capacitor.config.ts server.url).
    static let site = "https://webinarliv.com"
    private static let tokenKey = "webinarliv.voipToken"
    /// How long a call rings when its expiresAt is missing or unreadable.
    private static let defaultRing: TimeInterval = 45

    private struct Call {
        let id: String
        var answered = false
        var expiry: DispatchWorkItem?
    }

    private let provider: CXProvider
    private var registry: PKPushRegistry?
    private weak var plugin: CallRingingPlugin?
    private var pending: [(String, [String: Any])] = []
    private var calls: [UUID: Call] = [:]
    /// Calls that ended, so a late or repeated incoming_call does not ring again.
    private var ended: [String] = []
    private(set) var voipToken: String?

    private override init() {
        // The name CallKit shows is the bundle's display name, "Webinar Liv".
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        if let icon = UIImage(named: "CallKitIcon") {
            config.iconTemplateImageData = icon.pngData()
        }
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
        voipToken = UserDefaults.standard.string(forKey: CallRinging.tokenKey)
    }

    /// At launch, before the app finishes launching: a VoIP push that woke a killed app is
    /// delivered only once the registry exists.
    func start() {
        guard registry == nil else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    func attach(_ plugin: CallRingingPlugin) {
        DispatchQueue.main.async {
            self.plugin = plugin
            let queued = self.pending
            self.pending = []
            for (event, data) in queued { plugin.emit(event, data, retain: true) }
        }
    }

    private func emit(_ event: String, _ data: [String: Any], retain: Bool) {
        if let plugin = plugin {
            plugin.emit(event, data, retain: retain)
        } else if retain {
            pending.append((event, data))
        }
    }

    // ------------------------------------------------------------------ the push

    /// The call fields, flat at the top level or in "payload" / "data" (a dictionary or JSON).
    static func fields(_ raw: [AnyHashable: Any]) -> [String: String] {
        var dict: [AnyHashable: Any] = raw
        if raw["type"] == nil {
            for key in ["payload", "data"] {
                if let d = raw[key] as? [AnyHashable: Any] {
                    dict = d
                    break
                }
                if let s = raw[key] as? String, let data = s.data(using: .utf8),
                   let d = (try? JSONSerialization.jsonObject(with: data)) as? [AnyHashable: Any] {
                    dict = d
                    break
                }
            }
        }
        var out: [String: String] = [:]
        for (k, v) in dict {
            guard let key = k as? String else { continue }
            if let s = v as? String {
                out[key] = s
            } else if let n = v as? NSNumber {
                out[key] = n.stringValue
            }
        }
        return out
    }

    /// The call's CallKit UUID: its ID when that is a UUID, else one derived from it.
    static func uuid(for callId: String) -> UUID {
        if let u = UUID(uuidString: callId) { return u }
        var bytes = Array(Insecure.MD5.hash(data: Data(callId.utf8)))
        bytes[6] = (bytes[6] & 0x0F) | 0x30
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return NSUUID(uuidBytes: bytes) as UUID
    }

    static func expiry(_ raw: String?) -> Date {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return Date().addingTimeInterval(defaultRing)
        }
        if let n = Double(raw) {
            // Seconds or milliseconds since the epoch.
            return Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n)
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: raw) { return d }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: raw) { return d }
        return Date().addingTimeInterval(defaultRing)
    }

    private func remember(ended id: String) {
        if !ended.contains(id) { ended.append(id) }
        if ended.count > 50 { ended.removeFirst(ended.count - 50) }
    }

    private static func reason(forState state: String?) -> CXCallEndedReason {
        switch state ?? "" {
        case "accepted", "answered": return .answeredElsewhere
        case "declined": return .declinedElsewhere
        case "missed", "expired", "timeout", "unanswered": return .unanswered
        default: return .remoteEnded
        }
    }

    private func handle(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        let f = CallRinging.fields(payload)
        let id = f["callId"] ?? ""
        let uuid = CallRinging.uuid(for: id.isEmpty ? UUID().uuidString : id)
        let update = CXCallUpdate()
        let caller = (f["callerName"] ?? "").isEmpty ? "Webinar Liv call" : f["callerName"]!
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = true
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        let type = f["type"] ?? ""
        let expires = CallRinging.expiry(f["expiresAt"])
        if type == "incoming_call" && !id.isEmpty && !ended.contains(id) && expires > Date() {
            if calls[uuid] != nil {
                // The same call again (a retry): it is already ringing. Report, as iOS
                // requires, and let it ring.
                provider.reportNewIncomingCall(with: uuid, update: update) { _ in completion() }
                return
            }
            calls[uuid] = Call(id: id)
            provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
                defer { completion() }
                guard let self = self else { return }
                if let error = error {
                    // Do Not Disturb, a blocked caller, or a call already in progress.
                    print("Webinar Liv: incoming call not shown: \(error)")
                    self.calls[uuid] = nil
                    return
                }
                let timeout = DispatchWorkItem { [weak self] in
                    guard let self = self, let call = self.calls[uuid], !call.answered else { return }
                    self.calls[uuid] = nil
                    self.remember(ended: id)
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
                }
                self.calls[uuid]?.expiry = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + max(1, expires.timeIntervalSinceNow), execute: timeout)
            }
            return
        }

        // call_ended, an expired or finished call, or a push that is not a call: report it and
        // end it at once. A call that is ringing ends the same way.
        let reason: CXCallEndedReason
        if type == "call_ended" {
            reason = CallRinging.reason(forState: f["state"])
        } else if type == "incoming_call" {
            reason = .unanswered
        } else {
            reason = .failed
        }
        if !id.isEmpty { remember(ended: id) }
        let ringing = calls.removeValue(forKey: uuid)
        ringing?.expiry?.cancel()
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: nil, reason: reason)
            completion()
        }
    }

    // ------------------------------------------------------------------ the API

    /// POST /api/calls/{id}/{verb} with the WebView's session cookie. The answer's JSON, or nil
    /// on any failure (network, signed out, the call already over). Calls back on main.
    private func post(_ callId: String, _ verb: String, done: @escaping ([String: Any]?) -> Void) {
        let escaped = callId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? callId
        guard let url = URL(string: "\(CallRinging.site)/api/calls/\(escaped)/\(verb)") else {
            done(nil)
            return
        }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            let host = url.host ?? ""
            let mine = cookies.filter { c in
                let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
                return host == d || host.hasSuffix("." + d)
            }
            var req = URLRequest(url: url, timeoutInterval: 8)
            req.httpMethod = "POST"
            req.httpShouldHandleCookies = false
            for (k, v) in HTTPCookie.requestHeaderFields(with: mine) { req.setValue(v, forHTTPHeaderField: k) }
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.httpBody = Data("{}".utf8)
            URLSession.shared.dataTask(with: req) { data, res, _ in
                let status = (res as? HTTPURLResponse)?.statusCode ?? 0
                var json: [String: Any]?
                if (200..<300).contains(status) {
                    json = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
                } else {
                    print("Webinar Liv: \(verb) answered \(status)")
                }
                DispatchQueue.main.async { done(json) }
            }.resume()
        }
    }

    /// Keeps the app running while a request finishes after the user answered or declined
    /// from the lock screen.
    private func backgroundTask(_ name: String) -> () -> Void {
        var id = UIBackgroundTaskIdentifier.invalid
        id = UIApplication.shared.beginBackgroundTask(withName: name) {
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        return {
            if id != .invalid {
                UIApplication.shared.endBackgroundTask(id)
                id = .invalid
            }
        }
    }
}

extension CallRinging: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        voipToken = token
        UserDefaults.standard.set(token, forKey: CallRinging.tokenKey)
        emit("voipToken", ["token": token], retain: false)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = nil
        UserDefaults.standard.removeObject(forKey: CallRinging.tokenKey)
        emit("voipToken", ["token": ""], retain: false)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else {
            completion()
            return
        }
        handle(payload.dictionaryPayload, completion: completion)
    }
}

extension CallRinging: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        for call in calls.values { call.expiry?.cancel() }
        calls = [:]
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let uuid = action.callUUID
        guard var call = calls[uuid] else {
            action.fail()
            return
        }
        call.expiry?.cancel()
        call.answered = true
        calls[uuid] = call
        remember(ended: call.id)
        let finish = backgroundTask("call-accept")
        post(call.id, "accept") { [weak self] json in
            defer { finish() }
            guard let self = self else { return }
            guard let joinUrl = json?["joinUrl"] as? String, !joinUrl.isEmpty else {
                // Over already, or signed out: CallKit shows the call failed.
                action.fail()
                self.calls[uuid] = nil
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
                return
            }
            action.fulfill()
            self.emit("callAccepted", ["joinUrl": joinUrl, "callId": call.id], retain: true)
            // The meeting runs in the WebView: end the CallKit call so WebKit owns the audio.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                guard self.calls.removeValue(forKey: uuid) != nil else { return }
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .answeredElsewhere)
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        let call = calls.removeValue(forKey: uuid)
        call?.expiry?.cancel()
        action.fulfill()
        guard let call = call, !call.answered else { return }
        remember(ended: call.id)
        let finish = backgroundTask("call-decline")
        post(call.id, "decline") { _ in finish() }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        action.fulfill()
    }
}
