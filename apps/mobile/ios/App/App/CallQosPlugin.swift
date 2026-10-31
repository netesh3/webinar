import AVFoundation
import Capacitor

/**
 * Page → native: a live room wants a call-class audio session so iOS does not
 * treat webinar audio as "movie playback" and so Bluetooth / speaker routing
 * match a video call. web/lib/native-bridge.ts calls setActive from the same
 * path as keep-awake. AppDelegate still sets .playback at launch so opening
 * the app does not interrupt music.
 */
@objc(CallQosPlugin)
public class CallQosPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallQosPlugin"
    public let jsName = "CallQos"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setActive", returnType: CAPPluginReturnPromise),
    ]

    @objc func setActive(_ call: CAPPluginCall) {
        CallQos.setActive(call.getBool("on") ?? false)
        call.resolve()
    }
}

enum CallQos {
    static func setActive(_ on: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            if on {
                try session.setCategory(
                    .playAndRecord,
                    mode: .videoChat,
                    options: [.allowBluetooth, .allowBluetoothA2DP, .allowAirPlay, .defaultToSpeaker]
                )
            } else {
                try session.setCategory(
                    .playback,
                    mode: .moviePlayback,
                    options: [.allowAirPlay, .allowBluetoothA2DP]
                )
            }
        } catch {
            print("Webinar Liv: call QoS audio session failed: \(error)")
        }
    }
}
