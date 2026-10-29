package com.webinarliv.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What this build can do, for the page (web/lib/native-bridge.ts reads it as
 * window.Capacitor.Plugins.WebinarLivApp).
 *
 * pushConfigured: whether the build was made with google-services.json. Without it
 * Firebase is never initialised, and @capacitor/push-notifications' register() throws
 * on the main thread, which takes the whole app down. The page asks first.
 */
@CapacitorPlugin(name = "WebinarLivApp")
public class AppInfoPlugin extends Plugin {

    @PluginMethod
    public void info(PluginCall call) {
        // The google-services Gradle plugin writes this string resource; nothing else does.
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("pushConfigured", id != 0);
        call.resolve(ret);
    }
}
