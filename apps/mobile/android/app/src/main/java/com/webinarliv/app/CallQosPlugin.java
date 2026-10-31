package com.webinarliv.app;

import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Page → native: a live room wants dedicated radio / CPU / process priority.
 * web/lib/native-bridge.ts calls setActive from the same path as keep-awake.
 */
@CapacitorPlugin(name = "CallQos")
public class CallQosPlugin extends Plugin {

    @PluginMethod
    public void setActive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        CallQos.setRendererImportant(webView, on);
        try {
            if (on) CallQosService.start(getContext());
            else CallQosService.stop(getContext());
        } catch (RuntimeException e) {
            if (on) CallQos.acquire(getContext());
            else CallQos.release(getContext());
        }
        call.resolve();
    }
}
