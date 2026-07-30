package com.mori.downloader;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Records terminal DownloadManager state without starting an Activity or
 * keeping the application process alive for progress updates.
 */
public final class DownloadCompleteReceiver extends BroadcastReceiver {
    static final String ACTION_DOWNLOAD_STATE_CHANGED =
        "com.mori.downloader.action.DOWNLOAD_STATE_CHANGED";
    private static final ThreadPoolExecutor COMPLETION_EXECUTOR = createExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
            return;
        }

        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (id < 0) {
            return;
        }

        Context applicationContext = context.getApplicationContext();
        PendingResult pendingResult = goAsync();
        try {
            COMPLETION_EXECUTOR.execute(() -> {
                try {
                    DownloadRecordStore.reconcileOne(applicationContext, id);
                    Intent update = new Intent(ACTION_DOWNLOAD_STATE_CHANGED);
                    update.setPackage(applicationContext.getPackageName());
                    applicationContext.sendBroadcast(update);
                } finally {
                    pendingResult.finish();
                }
            });
        } catch (RejectedExecutionException ex) {
            // A later app-resume reconciliation can recover the terminal state.
            pendingResult.finish();
        }
    }

    private static ThreadPoolExecutor createExecutor() {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
            1,
            1,
            15L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(),
            task ->
                new Thread(
                    () -> {
                        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
                        task.run();
                    },
                    "mori-download-completions"
                )
        );
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }
}
