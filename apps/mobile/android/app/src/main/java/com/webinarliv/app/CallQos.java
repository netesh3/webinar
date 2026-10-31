package com.webinarliv.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.Process;
import android.webkit.WebView;

/**
 * Holds Wi-Fi, CPU and a high-bandwidth network request while a live room is
 * open, so Android does not idle the radio or demote the WebView the way it
 * does a background tab. Pair with CallQosService (foreground) for process
 * importance. Released when the page leaves the room.
 */
final class CallQos {

    private static final String TAG = "WebinarLiv:call";

    private static WifiManager.WifiLock wifiLock;
    private static PowerManager.WakeLock cpuLock;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static ConnectivityManager.NetworkCallback premiumCallback;
    private static int held;

    private CallQos() {}

    static synchronized void acquire(Context context) {
        if (held++ > 0) return;
        Context app = context.getApplicationContext();
        Process.setThreadPriority(Process.THREAD_PRIORITY_FOREGROUND);
        lockWifi(app);
        lockCpu(app);
        requestNetwork(app);
    }

    static synchronized void release(Context context) {
        if (held == 0) return;
        if (--held > 0) return;
        Context app = context.getApplicationContext();
        dropWifi();
        dropCpu();
        dropNetwork(app);
        Process.setThreadPriority(Process.THREAD_PRIORITY_DEFAULT);
    }

    static void setRendererImportant(WebView webView, boolean on) {
        if (webView == null || Build.VERSION.SDK_INT < 26) return;
        try {
            webView.setRendererPriorityPolicy(
                    on ? WebView.RENDERER_PRIORITY_IMPORTANT : WebView.RENDERER_PRIORITY_BOUND,
                    false);
        } catch (RuntimeException ignored) {
            // Older WebView stubs.
        }
    }

    @SuppressWarnings("deprecation")
    private static void lockWifi(Context app) {
        WifiManager wifi = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
        if (wifi == null) return;
        int mode = Build.VERSION.SDK_INT >= 29
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wifi.createWifiLock(mode, TAG);
        wifiLock.setReferenceCounted(false);
        try {
            wifiLock.acquire();
        } catch (RuntimeException e) {
            wifiLock = null;
        }
    }

    private static void dropWifi() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wifiLock = null;
    }

    private static void lockCpu(Context app) {
        PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG);
        cpuLock.setReferenceCounted(false);
        try {
            cpuLock.acquire();
        } catch (RuntimeException e) {
            cpuLock = null;
        }
    }

    private static void dropCpu() {
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        cpuLock = null;
    }

    private static void requestNetwork(Context app) {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        // Keep the default network from going idle. Capabilities are ALL required, so
        // this is only INTERNET — PRIORITIZE_BANDWIDTH is a second, optional request.
        networkCallback = new ConnectivityManager.NetworkCallback();
        try {
            cm.requestNetwork(
                    new NetworkRequest.Builder()
                            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            .build(),
                    networkCallback);
        } catch (RuntimeException e) {
            networkCallback = null;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            // Optional 5G high-bandwidth slice. Not bound to the process: if the
            // carrier has no such slice, onUnavailable is a no-op and we stay on
            // the default network (including cellular).
            premiumCallback = new ConnectivityManager.NetworkCallback();
            try {
                cm.requestNetwork(
                        new NetworkRequest.Builder()
                                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                                .addCapability(NetworkCapabilities.NET_CAPABILITY_PRIORITIZE_BANDWIDTH)
                                .build(),
                        premiumCallback);
            } catch (RuntimeException e) {
                premiumCallback = null;
            }
        }
    }

    private static void dropNetwork(Context app) {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            networkCallback = null;
            premiumCallback = null;
            return;
        }
        if (networkCallback != null) {
            try {
                cm.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
            }
            networkCallback = null;
        }
        if (premiumCallback != null) {
            try {
                cm.unregisterNetworkCallback(premiumCallback);
            } catch (RuntimeException ignored) {
            }
            premiumCallback = null;
        }
    }
}
