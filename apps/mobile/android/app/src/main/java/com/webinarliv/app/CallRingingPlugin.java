package com.webinarliv.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Incoming calls, as seen from the page (31 Oct 2026); web/lib/native-bridge.ts reads it as
 * window.Capacitor.Plugins.CallRinging. The ringing is all native (CallRinging); the page is
 * told when a call was answered, so it loads the meeting, and can ask about the full-screen
 * permission:
 *
 *   canRing()               {granted}: whether notifications are on, so a call can ring
 *   fullScreenIntent()      {granted, settings}: whether a call may take the lock screen
 *                           (always true before Android 14), and whether there is a setting
 *                           to send the user to
 *   openFullScreenSettings()  Settings → "Full-screen notifications" for this app
 *   "callAccepted" {joinUrl}  an answered call; kept until the page listens, so a cold start
 *                             from Answer still gets it
 */
@CapacitorPlugin(name = "CallRinging")
public class CallRingingPlugin extends Plugin {

    private static CallRingingPlugin instance;
    private static String pendingJoinUrl;

    @Override
    public void load() {
        String pending;
        synchronized (CallRingingPlugin.class) {
            instance = this;
            pending = pendingJoinUrl;
            pendingJoinUrl = null;
        }
        if (pending != null) emitAccepted(pending);
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (CallRingingPlugin.class) {
            if (instance == this) instance = null;
        }
        super.handleOnDestroy();
    }

    /** Main thread. Hands an answered call's join URL to the page, now or once it loads. */
    static void deliverAccepted(String joinUrl) {
        CallRingingPlugin p;
        synchronized (CallRingingPlugin.class) {
            p = instance;
            if (p == null) pendingJoinUrl = joinUrl;
        }
        if (p != null) p.emitAccepted(joinUrl);
    }

    private void emitAccepted(String joinUrl) {
        JSObject data = new JSObject();
        data.put("joinUrl", joinUrl);
        notifyListeners("callAccepted", data, true);
    }

    static boolean canUseFullScreenIntent(Context context) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm == null || nm.canUseFullScreenIntent();
    }

    /** Whether a call can ring at all: notifications are on for the app (Android 13+ asks). */
    @PluginMethod
    public void canRing(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(ret);
    }

    @PluginMethod
    public void fullScreenIntent(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canUseFullScreenIntent(getContext()));
        ret.put("settings", Build.VERSION.SDK_INT >= 34);
        call.resolve(ret);
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i;
        if (Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    Uri.parse("package:" + ctx.getPackageName()));
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + ctx.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (RuntimeException e) {
            // No such screen on this build: the app's details page instead.
            ctx.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }
}
