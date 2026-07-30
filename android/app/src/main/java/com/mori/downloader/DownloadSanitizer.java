package com.mori.downloader;

import java.net.URI;
import java.net.URISyntaxException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Pure-Java validation helpers shared by the native download bridge and unit
 * tests. These methods deliberately reject ambiguous input instead of trying
 * to repair URLs or paths that could escape the Downloads directory.
 */
final class DownloadSanitizer {
    static final int MAX_URL_LENGTH = 16_384;
    static final int MAX_FILE_NAME_LENGTH = 128;
    static final int MAX_SUBFOLDER_LENGTH = 160;
    static final int MAX_HEADER_VALUE_LENGTH = 1_024;

    private static final Pattern MIME_TYPE_PATTERN = Pattern.compile(
        "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+\\-]{0,126}$"
    );
    private static final Pattern ILLEGAL_FILE_CHARS = Pattern.compile("[\\\\/:*?\"<>|\\p{Cntrl}]");
    private static final Pattern REPEATED_WHITESPACE = Pattern.compile("\\s+");
    private static final Set<String> RESERVED_FILE_NAMES = Collections.unmodifiableSet(
        new HashSet<>(
            Arrays.asList(
                "CON",
                "PRN",
                "AUX",
                "NUL",
                "COM1",
                "COM2",
                "COM3",
                "COM4",
                "COM5",
                "COM6",
                "COM7",
                "COM8",
                "COM9",
                "LPT1",
                "LPT2",
                "LPT3",
                "LPT4",
                "LPT5",
                "LPT6",
                "LPT7",
                "LPT8",
                "LPT9"
            )
        )
    );

    private DownloadSanitizer() {}

    static URI requireHttpUrl(String rawValue) {
        if (rawValue == null) {
            throw new IllegalArgumentException("URL is required");
        }

        String value = rawValue.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("URL is required");
        }
        if (value.length() > MAX_URL_LENGTH) {
            throw new IllegalArgumentException("URL is too long");
        }
        requireNoControlCharacters(value, "URL");

        final URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException ex) {
            throw new IllegalArgumentException("URL is malformed", ex);
        }

        String scheme = uri.getScheme();
        if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
            throw new IllegalArgumentException("Only HTTP and HTTPS URLs are allowed");
        }
        if (uri.getRawAuthority() == null || uri.getRawAuthority().isEmpty() || uri.getHost() == null || uri.getHost().isEmpty()) {
            throw new IllegalArgumentException("URL must contain a valid host");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("URL user information is not allowed");
        }
        if (uri.getRawFragment() != null) {
            throw new IllegalArgumentException("URL fragments are not allowed");
        }
        if (isPrivateNetworkHost(uri.getHost())) {
            throw new IllegalArgumentException("Private or local network URLs are not allowed");
        }
        return uri;
    }

    static boolean isPrivateNetworkHost(String rawHost) {
        if (rawHost == null) {
            return true;
        }
        String host = rawHost
            .trim()
            .toLowerCase(Locale.ROOT)
            .replaceAll("^\\[|\\]$", "")
            .replaceAll("\\.$", "");
        if (
            host.isEmpty() ||
            "localhost".equals(host) ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            host.endsWith(".lan")
        ) {
            return true;
        }

        if (host.indexOf(':') >= 0) {
            return (
                "::".equals(host) ||
                "::1".equals(host) ||
                host.startsWith("fc") ||
                host.startsWith("fd") ||
                host.matches("^fe[89ab].*") ||
                host.startsWith("ff") ||
                host.startsWith("::ffff:") ||
                host.indexOf('%') >= 0
            );
        }

        if (host.indexOf('.') < 0) {
            return true;
        }
        if (!host.matches("^\\d+(?:\\.\\d+){3}$")) {
            return host.matches("^\\d+$");
        }

        String[] parts = host.split("\\.");
        int[] octets = new int[4];
        for (int index = 0; index < parts.length; index++) {
            try {
                octets[index] = Integer.parseInt(parts[index]);
            } catch (NumberFormatException ex) {
                return true;
            }
            if (octets[index] < 0 || octets[index] > 255) {
                return true;
            }
        }

        int first = octets[0];
        int second = octets[1];
        int third = octets[2];
        return (
            first == 0 ||
            first == 10 ||
            first == 127 ||
            (first == 100 && second >= 64 && second <= 127) ||
            (first == 169 && second == 254) ||
            (first == 172 && second >= 16 && second <= 31) ||
            (first == 192 && (second == 0 || second == 168 || (second == 88 && third == 99))) ||
            (first == 198 && (second == 18 || second == 19 || (second == 51 && third == 100))) ||
            (first == 203 && second == 0 && third == 113) ||
            first >= 224
        );
    }

    static String sanitizeSubfolder(String rawValue) {
        String value = rawValue == null ? "" : Normalizer.normalize(rawValue, Normalizer.Form.NFKC).trim();
        if (value.isEmpty()) {
            return "Mori";
        }
        requireNoControlCharacters(value, "Download subfolder");

        if (value.startsWith("/") || value.startsWith("\\") || value.matches("^[a-zA-Z]:.*")) {
            throw new IllegalArgumentException("Download subfolder must be relative");
        }

        String[] rawSegments = value.split("[/\\\\]+");
        List<String> safeSegments = new ArrayList<>();
        for (String rawSegment : rawSegments) {
            String segment = rawSegment.trim();
            if (segment.isEmpty() || ".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                throw new IllegalArgumentException("Download subfolder cannot contain parent traversal");
            }

            segment = sanitizePathSegment(segment);
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw new IllegalArgumentException("Download subfolder contains an invalid segment");
            }
            safeSegments.add(segment);
        }

        if (safeSegments.isEmpty()) {
            return "Mori";
        }

        String safePath = String.join("/", safeSegments);
        if (safePath.length() > MAX_SUBFOLDER_LENGTH) {
            throw new IllegalArgumentException("Download subfolder is too long");
        }
        return safePath;
    }

    static String sanitizeFileName(String rawValue, String fallbackValue) {
        String fallback = fallbackValue == null ? "Mori_media" : fallbackValue;
        String value = rawValue == null ? "" : Normalizer.normalize(rawValue, Normalizer.Form.NFKC).trim();
        if (value.isEmpty()) {
            value = fallback;
        }

        value = ILLEGAL_FILE_CHARS.matcher(value).replaceAll("_");
        value = REPEATED_WHITESPACE.matcher(value).replaceAll(" ").trim();
        value = trimTrailingDotsAndSpaces(value);
        value = trimLeadingDotsAndSpaces(value);

        if (value.isEmpty() || ".".equals(value) || "..".equals(value)) {
            value = fallback;
        }

        String baseName = value;
        int finalDot = value.lastIndexOf('.');
        if (finalDot > 0) {
            baseName = value.substring(0, finalDot);
        }
        if (RESERVED_FILE_NAMES.contains(baseName.toUpperCase(Locale.ROOT))) {
            value = "_" + value;
        }

        if (value.length() > MAX_FILE_NAME_LENGTH) {
            value = truncatePreservingExtension(value, MAX_FILE_NAME_LENGTH);
        }
        value = trimTrailingDotsAndSpaces(value);
        if (value.isEmpty()) {
            return "Mori_media";
        }
        return value;
    }

    static String requireMimeType(String rawValue, String fallbackValue) {
        String fallback = fallbackValue == null ? "application/octet-stream" : fallbackValue;
        String value = rawValue == null || rawValue.trim().isEmpty() ? fallback : rawValue.trim();
        requireNoControlCharacters(value, "MIME type");
        if (!MIME_TYPE_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException("MIME type is invalid");
        }
        return value.toLowerCase(Locale.ROOT);
    }

    static String sanitizeNotificationText(String rawValue, String fallbackValue, int maxLength) {
        String value = rawValue == null ? "" : Normalizer.normalize(rawValue, Normalizer.Form.NFKC);
        StringBuilder safe = new StringBuilder(Math.min(value.length(), maxLength));
        for (int i = 0; i < value.length() && safe.length() < maxLength; i++) {
            char character = value.charAt(i);
            safe.append(Character.isISOControl(character) ? ' ' : character);
        }
        String normalized = REPEATED_WHITESPACE.matcher(safe.toString()).replaceAll(" ").trim();
        return normalized.isEmpty() ? fallbackValue : normalized;
    }

    static String requireSafeHeaderValue(String headerName, String rawValue) {
        if (rawValue == null) {
            throw new IllegalArgumentException(headerName + " header value is required");
        }
        String value = rawValue.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException(headerName + " header value is required");
        }
        if (value.length() > MAX_HEADER_VALUE_LENGTH) {
            throw new IllegalArgumentException(headerName + " header is too long");
        }
        requireNoControlCharacters(value, headerName + " header");
        return value;
    }

    private static String sanitizePathSegment(String rawSegment) {
        String value = ILLEGAL_FILE_CHARS.matcher(rawSegment).replaceAll("_");
        value = REPEATED_WHITESPACE.matcher(value).replaceAll(" ").trim();
        value = trimLeadingDotsAndSpaces(trimTrailingDotsAndSpaces(value));
        if (value.length() > 60) {
            value = value.substring(0, 60);
        }
        return value;
    }

    private static void requireNoControlCharacters(String value, String label) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) {
                throw new IllegalArgumentException(label + " contains control characters");
            }
        }
    }

    private static String trimLeadingDotsAndSpaces(String value) {
        int index = 0;
        while (index < value.length()) {
            char character = value.charAt(index);
            if (character != '.' && character != ' ') {
                break;
            }
            index++;
        }
        return value.substring(index);
    }

    private static String trimTrailingDotsAndSpaces(String value) {
        int end = value.length();
        while (end > 0) {
            char character = value.charAt(end - 1);
            if (character != '.' && character != ' ') {
                break;
            }
            end--;
        }
        return value.substring(0, end);
    }

    private static String truncatePreservingExtension(String value, int maxLength) {
        int finalDot = value.lastIndexOf('.');
        if (finalDot > 0 && value.length() - finalDot <= 16) {
            String extension = value.substring(finalDot);
            int baseLength = Math.max(1, maxLength - extension.length());
            return value.substring(0, baseLength) + extension;
        }
        return value.substring(0, maxLength);
    }
}
