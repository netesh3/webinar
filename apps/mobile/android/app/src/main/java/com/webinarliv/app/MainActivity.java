package com.webinarliv.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins are registered before the bridge starts.
        registerPlugin(AppInfoPlugin.class);
        registerPlugin(CallQosPlugin.class);
        registerPlugin(CallRingingPlugin.class);
        super.onCreate(savedInstanceState);
        // Answer on an incoming call's notification or screen (CallRinging; 31 Oct 2026).
        CallRinging.handleAccept(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        CallRinging.handleAccept(this, intent);
    }
}
