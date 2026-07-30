package com.mori.downloader;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean downloadReceiverRegistered;
    private final BroadcastReceiver downloadStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (
                DownloadCompleteReceiver.ACTION_DOWNLOAD_STATE_CHANGED.equals(intent.getAction()) &&
                getBridge() != null
            ) {
                getBridge().triggerWindowJSEvent("moriBackgroundDownloadComplete");
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundDownloaderPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (!downloadReceiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                downloadStateReceiver,
                new IntentFilter(DownloadCompleteReceiver.ACTION_DOWNLOAD_STATE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED
            );
            downloadReceiverRegistered = true;
        }
    }

    @Override
    public void onStop() {
        if (downloadReceiverRegistered) {
            unregisterReceiver(downloadStateReceiver);
            downloadReceiverRegistered = false;
        }
        super.onStop();
    }
}
