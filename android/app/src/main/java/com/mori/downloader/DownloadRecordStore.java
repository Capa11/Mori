package com.mori.downloader;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Small persistent queue for DownloadManager IDs. One preference entry is used
 * per download so a completion receiver and a foreground bridge call cannot
 * overwrite an unrelated record.
 */
final class DownloadRecordStore {
    private static final Object LOCK = new Object();
    private static final String PREFERENCES_NAME = "mori_background_downloads";
    private static final String PENDING_PREFIX = "pending.";
    private static final String COMPLETED_PREFIX = "completed.";
    private static final String FAILED_PREFIX = "failed.";
    private static final long MISSING_RECORD_GRACE_MS = 60_000L;

    private DownloadRecordStore() {}

    static void persistPending(Context context, long id, JSONObject metadata) {
        synchronized (LOCK) {
            preferences(context).edit().putString(PENDING_PREFIX + id, metadata.toString()).commit();
        }
    }

    static void reconcileOne(Context context, long id) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String pendingJson = preferences.getString(PENDING_PREFIX + id, null);
            if (pendingJson == null) {
                return;
            }
            reconcileLocked(context, preferences, id, pendingJson);
        }
    }

    static ConsumeResult reconcileAndConsume(Context context) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            Map<String, ?> initialEntries = preferences.getAll();
            for (Map.Entry<String, ?> entry : initialEntries.entrySet()) {
                String key = entry.getKey();
                if (!key.startsWith(PENDING_PREFIX) || !(entry.getValue() instanceof String)) {
                    continue;
                }
                Long id = parseId(key, PENDING_PREFIX);
                if (id != null) {
                    reconcileLocked(context, preferences, id, (String) entry.getValue());
                }
            }

            List<JSONObject> downloads = new ArrayList<>();
            List<JSONObject> failures = new ArrayList<>();
            SharedPreferences.Editor editor = preferences.edit();
            for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
                String key = entry.getKey();
                Object value = entry.getValue();
                if (!(value instanceof String)) {
                    continue;
                }
                try {
                    if (key.startsWith(COMPLETED_PREFIX)) {
                        downloads.add(new JSONObject((String) value));
                        editor.remove(key);
                    } else if (key.startsWith(FAILED_PREFIX)) {
                        failures.add(new JSONObject((String) value));
                        editor.remove(key);
                    }
                } catch (JSONException ignored) {
                    editor.remove(key);
                }
            }
            editor.commit();
            return new ConsumeResult(downloads, failures);
        }
    }

    private static void reconcileLocked(Context context, SharedPreferences preferences, long id, String pendingJson) {
        JSONObject metadata;
        try {
            metadata = new JSONObject(pendingJson);
        } catch (JSONException ex) {
            metadata = new JSONObject();
            put(metadata, "id", id);
        }

        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            moveToFailure(preferences, id, metadata, -1, "DOWNLOAD_SERVICE_UNAVAILABLE");
            return;
        }

        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (Cursor cursor = manager.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                long createdAt = metadata.optLong("createdAt", 0L);
                if (createdAt > 0 && System.currentTimeMillis() - createdAt < MISSING_RECORD_GRACE_MS) {
                    return;
                }
                moveToFailure(preferences, id, metadata, -1, "DOWNLOAD_NOT_FOUND");
                return;
            }

            int status = getInt(cursor, DownloadManager.COLUMN_STATUS, DownloadManager.STATUS_PENDING);
            int reason = getInt(cursor, DownloadManager.COLUMN_REASON, 0);
            put(metadata, "bytesDownloaded", getLong(cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR, 0L));
            put(metadata, "totalBytes", getLong(cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES, -1L));

            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                Uri localUri = manager.getUriForDownloadedFile(id);
                put(metadata, "status", "completed");
                put(metadata, "completedAt", System.currentTimeMillis());
                if (localUri != null) {
                    put(metadata, "uri", localUri.toString());
                }
                moveRecord(preferences, id, COMPLETED_PREFIX, metadata);
            } else if (status == DownloadManager.STATUS_FAILED) {
                moveToFailure(preferences, id, metadata, reason, mapFailureReason(reason));
            }
        } catch (RuntimeException ex) {
            // Keep the pending record. A later consume call can retry the query
            // after DownloadProvider or storage becomes available again.
        }
    }

    private static void moveToFailure(
        SharedPreferences preferences,
        long id,
        JSONObject metadata,
        int reason,
        String failureCode
    ) {
        put(metadata, "status", "failed");
        put(metadata, "failedAt", System.currentTimeMillis());
        put(metadata, "reason", reason);
        put(metadata, "code", failureCode);
        moveRecord(preferences, id, FAILED_PREFIX, metadata);
    }

    private static void moveRecord(SharedPreferences preferences, long id, String targetPrefix, JSONObject metadata) {
        preferences.edit().remove(PENDING_PREFIX + id).putString(targetPrefix + id, metadata.toString()).commit();
    }

    private static int getInt(Cursor cursor, String column, int fallback) {
        int index = cursor.getColumnIndex(column);
        return index >= 0 ? cursor.getInt(index) : fallback;
    }

    private static long getLong(Cursor cursor, String column, long fallback) {
        int index = cursor.getColumnIndex(column);
        return index >= 0 ? cursor.getLong(index) : fallback;
    }

    private static Long parseId(String key, String prefix) {
        try {
            return Long.parseLong(key.substring(prefix.length()));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException ignored) {}
    }

    private static String mapFailureReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "CANNOT_RESUME";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                return "STORAGE_UNAVAILABLE";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
                return "FILE_ALREADY_EXISTS";
            case DownloadManager.ERROR_FILE_ERROR:
                return "FILE_ERROR";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
                return "HTTP_DATA_ERROR";
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "INSUFFICIENT_SPACE";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return "TOO_MANY_REDIRECTS";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "HTTP_ERROR";
            case DownloadManager.ERROR_UNKNOWN:
            default:
                return "DOWNLOAD_FAILED";
        }
    }

    static final class ConsumeResult {
        final List<JSONObject> downloads;
        final List<JSONObject> failures;

        ConsumeResult(List<JSONObject> downloads, List<JSONObject> failures) {
            this.downloads = downloads;
            this.failures = failures;
        }
    }
}
