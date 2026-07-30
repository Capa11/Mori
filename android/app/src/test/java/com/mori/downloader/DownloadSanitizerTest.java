package com.mori.downloader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.net.URI;
import org.junit.Test;

public class DownloadSanitizerTest {
    @Test
    public void acceptsStrictHttpAndHttpsUrls() {
        URI https = DownloadSanitizer.requireHttpUrl(" https://cdn.example.com/video.mp4?token=a%20b ");
        URI http = DownloadSanitizer.requireHttpUrl("http://media.example.com/file");

        assertEquals("https", https.getScheme());
        assertEquals("cdn.example.com", https.getHost());
        assertEquals("http", http.getScheme());
    }

    @Test
    public void rejectsUnsafeOrAmbiguousUrls() {
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl("file:///tmp/video.mp4"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl("https://user:pass@example.com/video"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl("https://example.com/video#fragment"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl("https://example.com/\nvideo"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl("https:///missing-host"));
    }

    @Test
    public void rejectsPrivateLocalAndReservedNetworkTargets() {
        String[] unsafeUrls = {
            "http://localhost/file",
            "http://service.internal/file",
            "http://127.0.0.1/file",
            "http://10.2.3.4/file",
            "http://100.64.1.2/file",
            "http://169.254.1.2/file",
            "http://172.16.4.5/file",
            "http://192.168.1.2/file",
            "http://198.18.0.1/file",
            "http://[::1]/file",
            "http://[fd00::1]/file",
            "http://[fe80::1]/file"
        };
        for (String url : unsafeUrls) {
            assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.requireHttpUrl(url));
        }

        assertEquals(
            "8.8.8.8",
            DownloadSanitizer.requireHttpUrl("https://8.8.8.8/media").getHost()
        );
        assertEquals(
            "[2606:4700:4700::1111]",
            DownloadSanitizer.requireHttpUrl("https://[2606:4700:4700::1111]/media").getHost()
        );
    }

    @Test
    public void keepsSubfoldersRelativeToDownloads() {
        assertEquals("Mori", DownloadSanitizer.sanitizeSubfolder(null));
        assertEquals("Mori/Music", DownloadSanitizer.sanitizeSubfolder(" Mori / Music "));
        assertEquals("Mori/My_Videos", DownloadSanitizer.sanitizeSubfolder("Mori/My:Videos"));

        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.sanitizeSubfolder("../escape"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.sanitizeSubfolder("Mori/../escape"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.sanitizeSubfolder("/absolute/path"));
        assertThrows(IllegalArgumentException.class, () -> DownloadSanitizer.sanitizeSubfolder("C:\\absolute\\path"));
    }

    @Test
    public void removesPathSyntaxAndReservedFileNames() {
        assertEquals("_evil_.mp4", DownloadSanitizer.sanitizeFileName("../evil?.mp4", "fallback.mp4"));
        assertEquals("_CON.mp4", DownloadSanitizer.sanitizeFileName("CON.mp4", "fallback.mp4"));
        assertEquals("fallback.mp4", DownloadSanitizer.sanitizeFileName(" ... ", "fallback.mp4"));
    }

    @Test
    public void limitsFileNameWhilePreservingExtension() {
        StringBuilder input = new StringBuilder();
        for (int i = 0; i < 180; i++) {
            input.append('a');
        }
        input.append(".mp4");

        String result = DownloadSanitizer.sanitizeFileName(input.toString(), "fallback.mp4");
        assertEquals(DownloadSanitizer.MAX_FILE_NAME_LENGTH, result.length());
        assertTrue(result.endsWith(".mp4"));
        assertFalse(result.contains("/"));
        assertFalse(result.contains("\\"));
    }

    @Test
    public void validatesMimeAndHeaderValues() {
        assertEquals("video/mp4", DownloadSanitizer.requireMimeType("Video/MP4", "application/octet-stream"));
        assertThrows(
            IllegalArgumentException.class,
            () -> DownloadSanitizer.requireMimeType("video/mp4; charset=utf-8", "application/octet-stream")
        );
        assertEquals(
            "Mori/1.0 (Android)",
            DownloadSanitizer.requireSafeHeaderValue("User-Agent", " Mori/1.0 (Android) ")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> DownloadSanitizer.requireSafeHeaderValue("Referer", "https://example.com\r\nInjected: yes")
        );
    }
}
