package com.mori.downloader;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.net.URI;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Hands resolved, direct HTTP(S) media URLs to Android's system DownloadManager.
 * The system owns the transfer after enqueue(), so Mori's WebView can close
 * without retaining a large response buffer or a foreground service.
 */
@CapacitorPlugin(
    name = "BackgroundDownloader",
    permissions = { @Permission(alias = "legacyStorage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) }
)
public final class BackgroundDownloaderPlugin extends Plugin {
    private static final String ERROR_INVALID_URL = "INVALID_URL";
    private static final String ERROR_INVALID_SOURCE_URL = "INVALID_SOURCE_URL";
    private static final String ERROR_INVALID_PATH = "INVALID_PATH";
    private static final String ERROR_INVALID_FILE_NAME = "INVALID_FILE_NAME";
    private static final String ERROR_INVALID_MIME_TYPE = "INVALID_MIME_TYPE";
    private static final String ERROR_UNSAFE_HEADER = "UNSAFE_HEADER";
    private static final String ERROR_STORAGE_PERMISSION_REQUIRED = "STORAGE_PERMISSION_REQUIRED";
    private static final String ERROR_DOWNLOAD_SERVICE_UNAVAILABLE = "DOWNLOAD_SERVICE_UNAVAILABLE";
    private static final String ERROR_DOWNLOAD_ENQUEUE_FAILED = "DOWNLOAD_ENQUEUE_FAILED";

    @PluginMethod
    public void enqueue(PluginCall call) {
        final URI downloadUri;
        try {
            downloadUri = DownloadSanitizer.requireHttpUrl(call.getString("url"));
        } catch (IllegalArgumentException ex) {
            call.reject(ex.getMessage(), ERROR_INVALID_URL);
            return;
        }

        String kind = sanitizeKind(call.getString("kind", "file"));
        String fallbackMime = defaultMimeType(kind);
        final String mimeType;
        try {
            mimeType = DownloadSanitizer.requireMimeType(call.getString("mimeType"), fallbackMime);
            if (!isAllowedDownloadMimeType(mimeType)) {
                throw new IllegalArgumentException("MIME type is not allowed for media downloads");
            }
        } catch (IllegalArgumentException ex) {
            call.reject(ex.getMessage(), ERROR_INVALID_MIME_TYPE);
            return;
        }

        final String subfolder;
        try {
            subfolder = DownloadSanitizer.sanitizeSubfolder(call.getString("subfolder", "Mori"));
        } catch (IllegalArgumentException ex) {
            call.reject(ex.getMessage(), ERROR_INVALID_PATH);
            return;
        }

        final String fileName;
        try {
            String fallbackFileName = "Mori_" + System.currentTimeMillis() + "." + extensionFor(mimeType, kind);
            fileName = DownloadSanitizer.sanitizeFileName(call.getString("fileName"), fallbackFileName);
        } catch (IllegalArgumentException ex) {
            call.reject(ex.getMessage(), ERROR_INVALID_FILE_NAME);
            return;
        }

        final Map<String, String> headers;
        try {
            headers = readSafeHeaders(call.getObject("headers"));
        } catch (IllegalArgumentException ex) {
            call.reject(ex.getMessage(), ERROR_UNSAFE_HEADER);
            return;
        }

        String sourceUrl = call.getString("sourceUrl", "");
        if (sourceUrl != null && !sourceUrl.trim().isEmpty()) {
            try {
                sourceUrl = DownloadSanitizer.requireHttpUrl(sourceUrl).toASCIIString();
            } catch (IllegalArgumentException ex) {
                call.reject(ex.getMessage(), ERROR_INVALID_SOURCE_URL);
                return;
            }
        } else {
            sourceUrl = "";
        }

        Context context = getContext();
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("legacyStorage", call, "legacyStoragePermissionCallback");
            return;
        }

        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("Android download service is unavailable", ERROR_DOWNLOAD_SERVICE_UNAVAILABLE);
            return;
        }

        boolean wifiOnly = Boolean.TRUE.equals(call.getBoolean("wifiOnly", false));
        boolean incognito = Boolean.TRUE.equals(call.getBoolean("incognito", false));
        String relativePath = subfolder + "/" + fileName;
        String publicPath = Environment.DIRECTORY_DOWNLOADS + "/" + relativePath;
        String title = DownloadSanitizer.sanitizeNotificationText(call.getString("title"), fileName, 100);
        String description = DownloadSanitizer.sanitizeNotificationText(
            call.getString("description"),
            "Downloading with Mori",
            160
        );

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUri.toASCIIString()))
                .setTitle(title)
                .setDescription(description)
                .setMimeType(mimeType)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, relativePath)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverRoaming(false);

            if (wifiOnly) {
                request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI);
                request.setAllowedOverMetered(false);
            }

            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                request.allowScanningByMediaScanner();
            }

            for (Map.Entry<String, String> header : headers.entrySet()) {
                request.addRequestHeader(header.getKey(), header.getValue());
            }

            long id = manager.enqueue(request);
            JSONObject metadata = createMetadata(
                id,
                publicPath,
                fileName,
                subfolder,
                mimeType,
                title,
                description,
                sourceUrl,
                kind,
                wifiOnly,
                incognito
            );
            DownloadRecordStore.persistPending(context, id, metadata);
            // Close the narrow enqueue/broadcast race for very small files:
            // if the completion broadcast arrived before metadata was stored,
            // querying now moves the record to its terminal bucket.
            DownloadRecordStore.reconcileOne(context, id);

            JSObject result = new JSObject();
            result.put("id", id);
            result.put("path", publicPath);
            call.resolve(result);
        } catch (SecurityException ex) {
            call.reject("Android denied access to the Downloads folder", ERROR_STORAGE_PERMISSION_REQUIRED, ex);
        } catch (IllegalArgumentException | IllegalStateException ex) {
            call.reject("Unable to enqueue download: " + ex.getMessage(), ERROR_DOWNLOAD_ENQUEUE_FAILED, ex);
        } catch (RuntimeException ex) {
            call.reject("Android download service failed", ERROR_DOWNLOAD_ENQUEUE_FAILED, ex);
        }
    }

    @PermissionCallback
    private void legacyStoragePermissionCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject(
                "Storage permission is required to save into Downloads on Android 9 and older.",
                ERROR_STORAGE_PERMISSION_REQUIRED
            );
            return;
        }
        enqueue(call);
    }

    @PluginMethod
    public void consumeCompleted(PluginCall call) {
        getBridge().execute(() -> {
            try {
                DownloadRecordStore.ConsumeResult consumed = DownloadRecordStore.reconcileAndConsume(getContext());
                JSArray downloads = new JSArray();
                JSArray failures = new JSArray();
                for (JSONObject record : consumed.downloads) {
                    downloads.put(JSObject.fromJSONObject(record));
                }
                for (JSONObject record : consumed.failures) {
                    failures.put(JSObject.fromJSONObject(record));
                }

                JSObject result = new JSObject();
                result.put("downloads", downloads);
                result.put("failures", failures);
                call.resolve(result);
            } catch (JSONException | RuntimeException ex) {
                call.reject("Unable to read completed downloads", "DOWNLOAD_RECONCILE_FAILED", ex);
            }
        });
    }

    @PluginMethod
    public void dismissShare(PluginCall call) {
        Activity activity = getActivity();
        if (!(activity instanceof ShareActivity)) {
            call.reject("dismissShare is only available in the share popup", "NOT_SHARE_ACTIVITY");
            return;
        }

        activity.runOnUiThread(() -> {
            ((ShareActivity) activity).finishWithAnimation();
            JSObject result = new JSObject();
            result.put("dismissed", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void openMainApp(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No Android activity is available", "ACTIVITY_UNAVAILABLE");
            return;
        }

        String sharedUrl = call.getString("url", "");
        Uri sharedUri = null;
        if (sharedUrl != null && !sharedUrl.trim().isEmpty()) {
            try {
                sharedUri = Uri.parse(DownloadSanitizer.requireHttpUrl(sharedUrl).toASCIIString());
            } catch (IllegalArgumentException ex) {
                call.reject(ex.getMessage(), ERROR_INVALID_SOURCE_URL);
                return;
            }
        }
        final Uri launchUri = sharedUri;

        activity.runOnUiThread(() -> {
            Intent intent = new Intent(activity, MainActivity.class);
            if (launchUri != null) {
                intent.setAction(Intent.ACTION_VIEW);
                intent.setData(launchUri);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            activity.startActivity(intent);
            if (activity instanceof ShareActivity) {
                ((ShareActivity) activity).finishWithAnimation();
            }
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        });
    }

    private static Map<String, String> readSafeHeaders(JSObject input) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (input == null) {
            return headers;
        }

        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String providedName = keys.next();
            String canonicalName;
            switch (providedName.toLowerCase(Locale.ROOT)) {
                case "user-agent":
                    canonicalName = "User-Agent";
                    break;
                case "referer":
                    canonicalName = "Referer";
                    break;
                case "accept":
                    canonicalName = "Accept";
                    break;
                default:
                    throw new IllegalArgumentException("Header is not allowed: " + providedName);
            }

            Object rawValue = input.opt(providedName);
            if (!(rawValue instanceof String)) {
                throw new IllegalArgumentException(canonicalName + " header must be text");
            }
            String value = DownloadSanitizer.requireSafeHeaderValue(canonicalName, (String) rawValue);
            if ("Referer".equals(canonicalName)) {
                value = DownloadSanitizer.requireHttpUrl(value).toASCIIString();
            }
            headers.put(canonicalName, value);
        }
        return headers;
    }

    private static JSONObject createMetadata(
        long id,
        String publicPath,
        String fileName,
        String subfolder,
        String mimeType,
        String title,
        String description,
        String sourceUrl,
        String kind,
        boolean wifiOnly,
        boolean incognito
    ) {
        JSONObject metadata = new JSONObject();
        put(metadata, "id", id);
        put(metadata, "status", "pending");
        put(metadata, "path", publicPath);
        put(metadata, "fileName", fileName);
        put(metadata, "subfolder", subfolder);
        put(metadata, "mimeType", mimeType);
        put(metadata, "title", title);
        put(metadata, "description", description);
        put(metadata, "sourceUrl", sourceUrl);
        put(metadata, "kind", kind);
        put(metadata, "wifiOnly", wifiOnly);
        put(metadata, "incognito", incognito);
        put(metadata, "createdAt", System.currentTimeMillis());
        return metadata;
    }

    private static String sanitizeKind(String rawKind) {
        if (rawKind == null) {
            return "video";
        }
        switch (rawKind.trim().toLowerCase(Locale.ROOT)) {
            case "audio":
                return "audio";
            case "image":
            case "photo":
            case "photos":
            case "gallery":
                return "image";
            case "archive":
            case "zip":
                return "archive";
            case "video":
                return "video";
            case "file":
            case "document":
            case "unknown":
            default:
                return "file";
        }
    }

    private static String defaultMimeType(String kind) {
        if ("audio".equals(kind)) {
            return "audio/mpeg";
        }
        if ("image".equals(kind)) {
            return "image/jpeg";
        }
        if ("video".equals(kind)) {
            return "video/mp4";
        }
        if ("archive".equals(kind)) {
            return "application/zip";
        }
        return "application/octet-stream";
    }

    private static boolean isAllowedDownloadMimeType(String mimeType) {
        return (
            mimeType.startsWith("video/") ||
            mimeType.startsWith("audio/") ||
            mimeType.startsWith("image/") ||
            "application/octet-stream".equals(mimeType) ||
            "application/pdf".equals(mimeType) ||
            "application/zip".equals(mimeType)
        );
    }

    private static String extensionFor(String mimeType, String kind) {
        switch (mimeType) {
            case "audio/mpeg":
                return "mp3";
            case "audio/mp4":
            case "audio/x-m4a":
                return "m4a";
            case "audio/ogg":
                return "ogg";
            case "image/png":
                return "png";
            case "image/webp":
                return "webp";
            case "image/gif":
                return "gif";
            case "application/pdf":
                return "pdf";
            case "application/zip":
                return "zip";
            case "video/webm":
                return "webm";
            case "video/mp4":
                return "mp4";
            case "image/jpeg":
                return "jpg";
            default:
                if ("audio".equals(kind)) {
                    return "mp3";
                }
                if ("image".equals(kind)) {
                    return "jpg";
                }
                if ("video".equals(kind)) {
                    return "mp4";
                }
                if ("archive".equals(kind)) {
                    return "zip";
                }
                return "bin";
        }
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException ignored) {}
    }
}
