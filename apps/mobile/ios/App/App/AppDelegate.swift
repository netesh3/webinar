import UIKit
import AVFoundation
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        return true
    }

    /* Background audio. With UIBackgroundModes "audio" in Info.plist and a playback
     * session, a webinar's sound (HLS <video> or LiveKit's remote audio) keeps playing
     * when the screen locks or the app goes to the background, and is not silenced by
     * the ring/silent switch. CallQosPlugin switches this to playAndRecord / videoChat
     * while a live room is open (web/lib/native-bridge.ts), which is the call-class
     * session; this launch default does not interrupt music just for opening the app.
     * WebKit still moves the session to play-and-record while the page captures the
     * microphone, so this does not get in WebRTC's way. */
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Category only, not setActive: activating at launch would stop whatever
            // music the user had playing just for opening the app. WebKit activates
            // the session when the page actually starts playing media.
            try session.setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay, .allowBluetoothA2DP])
        } catch {
            print("Webinar Liv: audio session setup failed: \(error)")
        }
    }

    /* Push: hand the APNs token to @capacitor-firebase/messaging, which gives it to Firebase
     * and hands the page an FCM token for it (29 Oct 2026). The plugin configures Firebase
     * itself from GoogleService-Info.plist, and stays off (no crash) when the plist is not in
     * the build; the "Copy Firebase config" build phase copies it in when it is present. */
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(name: Notification.Name("didReceiveRemoteNotification"),
                                        object: completionHandler, userInfo: userInfo)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
