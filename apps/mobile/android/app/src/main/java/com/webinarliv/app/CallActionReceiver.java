package com.webinarliv.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Decline on an incoming call's notification or screen (31 Oct 2026): stops the ringing and
 * POSTs /api/calls/{id}/decline with the WebView's session cookie (CallRinging), without
 * opening the app. goAsync keeps the process up until the POST is done.
 */
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !CallRinging.ACTION_DECLINE.equals(intent.getAction())) return;
        String callId = intent.getStringExtra(CallRinging.EXTRA_CALL_ID);
        if (callId == null || callId.isEmpty()) return;
        final PendingResult pending = goAsync();
        CallRinging.decline(context.getApplicationContext(), callId, pending::finish);
    }
}
