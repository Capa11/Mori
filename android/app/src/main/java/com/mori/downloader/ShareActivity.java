package com.mori.downloader;

import android.content.ClipData;
import android.content.Intent;
import android.content.res.Resources;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Translucent share-target surface. It loads a small, dedicated web entry point
 * and never opens the full Mori screen or injects shared text as JavaScript.
 */
public final class ShareActivity extends BridgeActivity {
    private static final int MAX_SHARED_TEXT_LENGTH = 64 * 1024;
    private static final int MAX_SHARED_URL_LENGTH = 8 * 1024;
    private static final Pattern HTTP_URL_PATTERN = Pattern.compile("(?i)\\bhttps?://[^\\s<>\"']+");
    private static final String TRAILING_PUNCTUATION = ".,;:!?)]}>";

    private Intent lastHandledIntent;

    @Override
    protected void onApplyThemeResource(Resources.Theme theme, int resourceId, boolean first) {
        // BridgeActivity applies its own non-dialog theme during onCreate().
        // Keep this Activity translucent regardless of that internal call.
        super.onApplyThemeResource(theme, R.style.AppTheme_ShareOverlay, first);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Intent initialIntent = getIntent();
        lastHandledIntent = initialIntent;
        config = createShareConfig(initialIntent);
        registerPlugin(BackgroundDownloaderPlugin.class);
        super.onCreate(savedInstanceState);

        configureOverlayWindow();
        configureShareWebView();
        getOnBackPressedDispatcher()
            .addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        finishWithAnimation();
                    }
                }
            );
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
        if (intent != lastHandledIntent && getBridge() != null) {
            loadSharedIntent(intent);
        }
    }

    void finishWithAnimation() {
        finish();
        overridePendingTransition(R.anim.share_sheet_stay, R.anim.share_sheet_exit);
    }

    private void configureOverlayWindow() {
        Window window = getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.width = WindowManager.LayoutParams.MATCH_PARENT;
        attributes.height = WindowManager.LayoutParams.MATCH_PARENT;
        attributes.dimAmount = 0.42f;
        window.setAttributes(attributes);

        View decor = window.getDecorView();
        decor.setBackgroundColor(Color.TRANSPARENT);
    }

    private void configureShareWebView() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) {
            return;
        }

        webView.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = webView.getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
    }

    private void loadSharedIntent(Intent intent) {
        lastHandledIntent = intent;
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) {
            finishWithAnimation();
            return;
        }

        String sharedUrl = extractFirstHttpUrl(intent);
        Uri.Builder page = Uri.parse(trimTrailingSlash(getBridge().getLocalUrl()) + "/share.html").buildUpon();
        if (sharedUrl == null) {
            page.appendQueryParameter("error", "no_valid_url");
        } else {
            page.appendQueryParameter("url", sharedUrl);
        }
        webView.loadUrl(page.build().toString());
    }

    /**
     * Gives this Activity its own lightweight start page. BridgeActivity would
     * otherwise begin loading index.html before we could navigate to the share
     * sheet, briefly executing the full application's startup work.
     */
    private CapConfig createShareConfig(Intent intent) {
        JSONObject pluginConfiguration = new JSONObject();
        try {
            pluginConfiguration.put("CapacitorHttp", new JSONObject().put("enabled", true));
            pluginConfiguration.put("CapacitorCookies", new JSONObject().put("enabled", true));
        } catch (JSONException ignored) {
            // These are constant JSON values; falling back to an empty plugin
            // configuration still leaves directly invoked Capacitor plugins usable.
        }

        return new CapConfig.Builder(this)
            .setStartPath(buildSharePagePath(intent))
            .setPluginsConfiguration(pluginConfiguration)
            .setBackgroundColor("#00000000")
            .setInitialFocus(true)
            .create();
    }

    private static String buildSharePagePath(Intent intent) {
        Uri.Builder page = Uri.parse("/share.html").buildUpon();
        String sharedUrl = extractFirstHttpUrl(intent);
        if (sharedUrl == null) {
            page.appendQueryParameter("error", "no_valid_url");
        } else {
            page.appendQueryParameter("url", sharedUrl);
        }
        return page.build().toString();
    }

    private static String extractFirstHttpUrl(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return null;
        }

        String mimeType = intent.getType();
        if (mimeType == null || !mimeType.toLowerCase(Locale.ROOT).startsWith("text/")) {
            return null;
        }

        String result = extractFirstHttpUrl(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        if (result != null) {
            return result;
        }

        result = extractFirstHttpUrl(intent.getStringExtra(Intent.EXTRA_HTML_TEXT));
        if (result != null) {
            return result;
        }

        ClipData clipData = intent.getClipData();
        if (clipData == null) {
            return null;
        }
        int itemCount = Math.min(clipData.getItemCount(), 32);
        for (int index = 0; index < itemCount; index++) {
            ClipData.Item item = clipData.getItemAt(index);
            result = extractFirstHttpUrl(item.getText());
            if (result == null) {
                result = extractFirstHttpUrl(item.getHtmlText());
            }
            if (result == null && item.getUri() != null) {
                result = extractFirstHttpUrl(item.getUri().toString());
            }
            if (result != null) {
                return result;
            }
        }
        return null;
    }

    private static String extractFirstHttpUrl(CharSequence input) {
        if (input == null) {
            return null;
        }
        String text = input.toString();
        if (text.length() > MAX_SHARED_TEXT_LENGTH) {
            text = text.substring(0, MAX_SHARED_TEXT_LENGTH);
        }

        Matcher matcher = HTTP_URL_PATTERN.matcher(text);
        while (matcher.find()) {
            String candidate = trimTrailingPunctuation(matcher.group());
            if (isSafeSharedUrl(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static boolean isSafeSharedUrl(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_SHARED_URL_LENGTH) {
            return false;
        }
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) {
                return false;
            }
        }

        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            return (
                scheme != null &&
                (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) &&
                uri.getHost() != null &&
                !uri.getHost().isEmpty() &&
                uri.getRawUserInfo() == null
            );
        } catch (URISyntaxException ex) {
            return false;
        }
    }

    private static String trimTrailingPunctuation(String value) {
        int end = value.length();
        while (end > 0 && TRAILING_PUNCTUATION.indexOf(value.charAt(end - 1)) >= 0) {
            end--;
        }
        return value.substring(0, end);
    }

    private static String trimTrailingSlash(String value) {
        if (value == null) {
            return "https://localhost";
        }
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }
}
