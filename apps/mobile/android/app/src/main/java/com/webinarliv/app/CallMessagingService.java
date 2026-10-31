package com.webinarliv.app;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.RemoteMessage;
import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;

/**
 * The app's FirebaseMessagingService (31 Oct 2026). Android hands a data message to one
 * MESSAGING_EVENT service, in the app's process, even when the app was swiped away; with only
 * @capacitor-firebase/messaging's MessagingService, the message goes to the page, which is not
 * running then. This subclass replaces it in the manifest (tools:node="remove" on the plugin's):
 * call messages (incoming_call, call_ended) ring natively here (CallRinging), and everything
 * else, and every token, goes on to the plugin exactly as before.
 */
public class CallMessagingService extends MessagingService {

    @Override
    public void onNewToken(@NonNull String token) {
        // The plugin hands a rotated token to the page, which sends it to the API.
        super.onNewToken(token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        if (CallRinging.handle(getApplicationContext(), remoteMessage.getData())) return;
        super.onMessageReceived(remoteMessage);
    }
}
