package com.webinarliv.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service so Android treats a live webinar like a call, not a
 * background tab: the process stays in the FOREGROUND bucket, which is what
 * stops the OS killing the WebView under memory pressure (see README Limits).
 */
public class CallQosService extends Service {

    static final String ACTION_START = "com.webinarliv.app.qos.START";
    static final String ACTION_STOP = "com.webinarliv.app.qos.STOP";

    private static final String CHANNEL_ID = "webinarliv.call";
    private static final int NOTIFICATION_ID = 4101;

    static void start(Context context) {
        Intent i = new Intent(context, CallQosService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    static void stop(Context context) {
        context.startService(new Intent(context, CallQosService.class).setAction(ACTION_STOP));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            CallQos.release(this);
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException e) {
            // Type / notification permission refused: still hold the radio/CPU locks.
        }
        CallQos.acquire(this);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        CallQos.release(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.call_qos_channel),
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.call_qos_notification));
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        Intent launch = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(this, 0, launch, piFlags);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.call_qos_notification))
                .setContentIntent(tap)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .build();
    }
}
