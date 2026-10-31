package com.webinarliv.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.CookieManager;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/**
 * Incoming calls on Android (31 Oct 2026).
 *
 * A host calling this account sends an FCM data message (no notification block, high
 * priority), which reaches CallMessagingService even when the app was swiped away. Its data is
 * the shared call contract:
 *
 *   {"type":"incoming_call","callId","callerName","callerAvatarUrl","meetingSlug","topic","joinUrl","expiresAt"}
 *   {"type":"call_ended","callId","state"}
 *
 * as flat data keys, or the same JSON in one "payload" key. incoming_call posts a call-style
 * notification on a high-importance channel that rings with the default ringtone (looping,
 * FLAG_INSISTENT) and vibrates: NotificationCompat.CallStyle, which is the system's call
 * notification on API 31+ and a CATEGORY_CALL notification with Answer / Decline buttons below
 * it, with a full-screen intent (IncomingCallActivity) that lights the screen over the lock
 * screen. It times out at expiresAt. call_ended takes it away.
 *
 * Android 14+ only lets an app use a full-screen intent once the user allows it
 * (NotificationManager.canUseFullScreenIntent); without it the system shows the same
 * notification as a heads-up instead, which still rings. CallRingingPlugin lets the page check
 * and open the setting (web/lib/native-bridge.ts asks once).
 *
 * Answer and Decline call the API natively, POST /api/calls/{id}/accept or /decline, with the
 * WebView's own session cookie from CookieManager: they work from the lock screen with no page
 * loaded. Accept then hands the answer's joinUrl to the page (CallRingingPlugin's
 * "callAccepted" event, kept until the page listens), which loads it.
 */
final class CallRinging {

    static final String TAG = "WebinarLivCall";
    static final String SITE = "https://webinarliv.com";
    static final String CHANNEL_ID = "webinarliv.incoming_call.v1";

    static final String ACTION_ACCEPT = "com.webinarliv.app.call.ACCEPT";
    static final String ACTION_DECLINE = "com.webinarliv.app.call.DECLINE";
    static final String EXTRA_CALL_ID = "callId";
    static final String EXTRA_JOIN_URL = "joinUrl";
    static final String EXTRA_CALLER = "callerName";
    static final String EXTRA_TOPIC = "topic";
    static final String EXTRA_EXPIRES = "expiresAtMs";

    /** How long a call rings when its expiresAt is missing or unreadable. */
    private static final long DEFAULT_RING_MS = 45_000L;
    private static final long[] VIBRATION = {0, 800, 600, 800, 600};

    /** Calls that ended before (or while) they rang, so a late incoming_call does not ring. */
    private static final Set<String> ended = Collections.synchronizedSet(new LinkedHashSet<>());
    /** The full-screen screen on show, so call_ended can close it. */
    private static WeakReference<Activity> screen = new WeakReference<>(null);

    private CallRinging() {}

    // ------------------------------------------------------------------ the message

    /** The call fields of an FCM data message, flat or in "payload". Null when it is not a call. */
    static Map<String, String> callData(Map<String, String> data) {
        if (data == null) return null;
        Map<String, String> out = new HashMap<>(data);
        String raw = data.get("payload");
        if (!data.containsKey("type") && raw != null) {
            try {
                JSONObject o = new JSONObject(raw);
                for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                    String k = it.next();
                    out.put(k, o.optString(k, ""));
                }
            } catch (Exception e) {
                return null;
            }
        }
        String type = out.get("type");
        if (!"incoming_call".equals(type) && !"call_ended".equals(type)) return null;
        if (TextUtils.isEmpty(out.get("callId"))) return null;
        return out;
    }

    /** Handles a call message. True when it was one (CallMessagingService then stops). */
    static boolean handle(Context context, Map<String, String> data) {
        Map<String, String> call = callData(data);
        if (call == null) return false;
        String id = call.get("callId");
        if ("call_ended".equals(call.get("type"))) {
            markEnded(id);
            dismiss(context, id);
        } else {
            ring(context, call);
        }
        return true;
    }

    static long expiresAtMs(String raw) {
        long now = System.currentTimeMillis();
        if (TextUtils.isEmpty(raw)) return now + DEFAULT_RING_MS;
        try {
            long n = Long.parseLong(raw.trim());
            // Seconds or milliseconds since the epoch.
            return n < 100_000_000_000L ? n * 1000L : n;
        } catch (NumberFormatException ignored) {
            // RFC 3339, below.
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                return java.time.OffsetDateTime.parse(raw.trim()).toInstant().toEpochMilli();
            } catch (Exception ignored) {
                // Unreadable: the default.
            }
        }
        return now + DEFAULT_RING_MS;
    }

    private static void markEnded(String id) {
        ended.add(id);
        synchronized (ended) {
            while (ended.size() > 50) {
                ended.remove(ended.iterator().next());
            }
        }
    }

    static int notificationId(String callId) {
        return 0x5ca1 ^ callId.hashCode();
    }

    // ------------------------------------------------------------------ ringing

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, context.getString(R.string.call_channel), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(context.getString(R.string.call_channel_description));
        ch.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(VIBRATION);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setBypassDnd(false);
        nm.createNotificationChannel(ch);
    }

    private static int piFlags() {
        int f = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) f |= PendingIntent.FLAG_IMMUTABLE;
        return f;
    }

    static void ring(Context context, Map<String, String> call) {
        String id = call.get("callId");
        long expires = expiresAtMs(call.get("expiresAt"));
        long left = expires - System.currentTimeMillis();
        if (ended.contains(id) || left <= 0) return;

        String caller = TextUtils.isEmpty(call.get("callerName")) ? context.getString(R.string.call_unknown_caller) : call.get("callerName");
        String topic = call.get("topic") == null ? "" : call.get("topic");
        String joinUrl = call.get("joinUrl") == null ? "" : call.get("joinUrl");
        int nid = notificationId(id);
        ensureChannel(context);

        Intent accept = new Intent(context, MainActivity.class)
                .setAction(ACTION_ACCEPT)
                .putExtra(EXTRA_CALL_ID, id)
                .putExtra(EXTRA_JOIN_URL, joinUrl)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent decline = new Intent(context, CallActionReceiver.class)
                .setAction(ACTION_DECLINE)
                .putExtra(EXTRA_CALL_ID, id);
        Intent full = new Intent(context, IncomingCallActivity.class)
                .putExtra(EXTRA_CALL_ID, id)
                .putExtra(EXTRA_JOIN_URL, joinUrl)
                .putExtra(EXTRA_CALLER, caller)
                .putExtra(EXTRA_TOPIC, topic)
                .putExtra(EXTRA_EXPIRES, expires)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent acceptPi = PendingIntent.getActivity(context, nid, accept, piFlags());
        PendingIntent declinePi = PendingIntent.getBroadcast(context, nid, decline, piFlags());
        PendingIntent fullPi = PendingIntent.getActivity(context, nid + 1, full, piFlags());

        Person person = new Person.Builder().setName(caller).setImportant(true).build();
        String text = TextUtils.isEmpty(topic) ? context.getString(R.string.call_incoming_video) : topic;
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_call)
                .setContentTitle(caller)
                .setContentText(text)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(fullPi)
                .setFullScreenIntent(fullPi, true)
                .setTimeoutAfter(left)
                // Before Android 8 the channel's sound and vibration do not exist.
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
                .setVibrate(VIBRATION)
                .addPerson(person)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, declinePi, acceptPi).setIsVideo(true));
        Notification n = b.build();
        // Ring until answered, declined or timed out, not once.
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(context).notify(nid, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused: nothing can ring.
            Log.w(TAG, "incoming call not shown: notifications are off", e);
        }
    }

    /** Stops ringing for this call: the notification and the full-screen screen. */
    static void dismiss(Context context, String callId) {
        if (callId == null) return;
        NotificationManagerCompat.from(context).cancel(notificationId(callId));
        Activity a = screen.get();
        if (a instanceof IncomingCallActivity && callId.equals(((IncomingCallActivity) a).callId())) {
            a.runOnUiThread(a::finish);
        }
    }

    static void showing(Activity a) {
        screen = new WeakReference<>(a);
    }

    // ------------------------------------------------------------------ answer and decline

    /** The WebView's cookies for the site: the signed-in session. Main thread. */
    static String siteCookies() {
        try {
            return CookieManager.getInstance().getCookie(SITE);
        } catch (RuntimeException e) {
            // No WebView provider (being updated): no session.
            return null;
        }
    }

    /**
     * POST /api/calls/{id}/{verb} with the session cookie. The answer's JSON, or null on any
     * failure (network, signed out, the call already over). Not the main thread.
     */
    static JSONObject post(String callId, String verb, String cookies) {
        HttpURLConnection c = null;
        try {
            URL url = new URL(SITE + "/api/calls/" + URLEncoder.encode(callId, "UTF-8") + "/" + verb);
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            if (!TextUtils.isEmpty(cookies)) c.setRequestProperty("Cookie", cookies);
            try (OutputStream out = c.getOutputStream()) {
                out.write("{}".getBytes(StandardCharsets.UTF_8));
            }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, verb + " answered " + status);
                return null;
            }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int n;
                while ((n = in.read(chunk)) > 0 && buf.size() < 65536) buf.write(chunk, 0, n);
                String body = buf.toString("UTF-8").trim();
                return body.isEmpty() ? new JSONObject() : new JSONObject(body);
            }
        } catch (Exception e) {
            Log.w(TAG, verb + " failed", e);
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Decline: stop ringing now, then tell the API. Not the main thread for the POST. */
    static void decline(Context context, String callId, Runnable done) {
        dismiss(context, callId);
        markEnded(callId);
        String cookies = siteCookies();
        new Thread(() -> {
            post(callId, "decline", cookies);
            if (done != null) done.run();
        }, "call-decline").start();
    }

    /**
     * Answer, from MainActivity's ACCEPT intent: stop ringing, accept through the API, and hand
     * the join URL to the page. True when the intent was an answer.
     */
    static boolean handleAccept(Activity activity, Intent intent) {
        if (intent == null || !ACTION_ACCEPT.equals(intent.getAction())) return false;
        String callId = intent.getStringExtra(EXTRA_CALL_ID);
        // Consumed: a configuration change or a later onNewIntent must not answer again.
        intent.setAction(Intent.ACTION_MAIN);
        if (TextUtils.isEmpty(callId)) return true;
        dismiss(activity, callId);
        markEnded(callId);
        String cookies = siteCookies();
        Context app = activity.getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            JSONObject res = post(callId, "accept", cookies);
            String url = res == null ? "" : res.optString("joinUrl", "");
            main.post(() -> {
                if (TextUtils.isEmpty(url)) {
                    Toast.makeText(app, R.string.call_no_longer_ringing, Toast.LENGTH_LONG).show();
                } else {
                    CallRingingPlugin.deliverAccepted(url);
                }
            });
        }, "call-accept").start();
        return true;
    }
}
