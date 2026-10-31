package com.webinarliv.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The full-screen incoming call (31 Oct 2026): what the notification's full-screen intent
 * opens over the lock screen, or when the phone is idle. Caller, topic, Decline and Accept;
 * the ringing itself is the notification's. Closes at expiresAt, on call_ended
 * (CallRinging.dismiss), or on either button. Built in code: one screen, no layout file.
 */
public class IncomingCallActivity extends Activity {

    private String callId;
    private String joinUrl;
    private final Handler handler = new Handler(Looper.getMainLooper());

    String callId() {
        return callId;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void bind(Intent intent) {
        callId = intent.getStringExtra(CallRinging.EXTRA_CALL_ID);
        joinUrl = intent.getStringExtra(CallRinging.EXTRA_JOIN_URL);
        if (TextUtils.isEmpty(callId)) {
            finish();
            return;
        }
        long left = intent.getLongExtra(CallRinging.EXTRA_EXPIRES, 0) - System.currentTimeMillis();
        if (left <= 0) {
            finish();
            return;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::finish, left);
        CallRinging.showing(this);
        setContentView(layout(intent.getStringExtra(CallRinging.EXTRA_CALLER),
                intent.getStringExtra(CallRinging.EXTRA_TOPIC)));
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private View layout(String caller, String topic) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0d0d11"));
        root.setPadding(dp(24), dp(96), dp(24), dp(64));

        TextView app = new TextView(this);
        app.setText(getString(R.string.call_incoming_video));
        app.setTextColor(Color.parseColor("#b8c3ff"));
        app.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        app.setGravity(Gravity.CENTER);
        root.addView(app);

        TextView name = new TextView(this);
        name.setText(TextUtils.isEmpty(caller) ? getString(R.string.call_unknown_caller) : caller);
        name.setTextColor(Color.WHITE);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32);
        name.setGravity(Gravity.CENTER);
        name.setPadding(0, dp(16), 0, dp(8));
        root.addView(name);

        if (!TextUtils.isEmpty(topic)) {
            TextView t = new TextView(this);
            t.setText(topic);
            t.setTextColor(Color.parseColor("#c9c9d1"));
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            t.setGravity(Gravity.CENTER);
            root.addView(t);
        }

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(button(R.string.call_decline, "#e5484d", v -> decline()), buttonParams());
        buttons.addView(button(R.string.call_accept, "#30a46c", v -> accept()), buttonParams());
        root.addView(buttons);
        return root;
    }

    private LinearLayout.LayoutParams buttonParams() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(64), 1f);
        p.setMargins(dp(12), 0, dp(12), 0);
        return p;
    }

    private Button button(int label, String color, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setAllCaps(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(color));
        bg.setCornerRadius(dp(32));
        b.setBackground(bg);
        b.setOnClickListener(onClick);
        return b;
    }

    private void decline() {
        CallRinging.decline(getApplicationContext(), callId, null);
        finish();
    }

    private void accept() {
        Intent i = new Intent(this, MainActivity.class)
                .setAction(CallRinging.ACTION_ACCEPT)
                .putExtra(CallRinging.EXTRA_CALL_ID, callId)
                .putExtra(CallRinging.EXTRA_JOIN_URL, joinUrl)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
        finish();
    }
}
