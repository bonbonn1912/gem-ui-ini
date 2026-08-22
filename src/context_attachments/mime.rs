use crate::attachments::detect_image_mime;
use std::path::Path;

pub fn sniff_mime(bytes: &[u8], display_name: &str) -> String {
    if let Some(mime) = detect_image_mime(bytes) {
        return mime.as_str().to_owned();
    }
    if bytes.starts_with(b"%PDF-") {
        return "application/pdf".to_owned();
    }
    if bytes.starts_with(&[0x50, 0x4b, 0x03, 0x04]) {
        return "application/zip".to_owned();
    }
    if !looks_like_utf8(bytes) {
        return "application/octet-stream".to_owned();
    }
    match Path::new(display_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "jsonl" => "application/x-ndjson",
        "js" => "text/javascript",
        "jsx" => "text/jsx",
        "ts" => "text/typescript",
        "tsx" => "text/tsx",
        "css" => "text/css",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "sql" => "application/sql",
        "py" => "text/x-python",
        "java" => "text/x-java-source",
        "kt" => "text/x-kotlin",
        "go" => "text/x-go",
        "rs" => "text/x-rust",
        "sh" => "application/x-sh",
        _ => "text/plain",
    }
    .to_owned()
}
pub fn is_textual_mime(value: &str) -> bool {
    value.starts_with("text/")
        || matches!(
            value,
            "application/json"
                | "application/x-ndjson"
                | "application/xml"
                | "application/yaml"
                | "application/toml"
                | "application/sql"
                | "application/x-sh"
        )
}
pub fn syntax_language(mime: &str, name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "markdown",
        "ts" => "typescript",
        "tsx" => "tsx",
        "js" => "javascript",
        "jsx" => "jsx",
        "json" | "jsonl" => "json",
        "csv" => "csv",
        "tsv" => "tsv",
        "py" => "python",
        "java" => "java",
        "kt" => "kotlin",
        "go" => "go",
        "rs" => "rust",
        "sh" => "bash",
        "css" => "css",
        "html" => "html",
        "xml" => "xml",
        "yaml" | "yml" => "yaml",
        "sql" => "sql",
        _ if mime == "application/pdf" => "text",
        _ => "text",
    }
}
fn looks_like_utf8(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{is_textual_mime, sniff_mime};

    #[test]
    fn magic_mime_wins_over_a_misleading_extension() {
        assert_eq!(sniff_mime(b"%PDF-1.7", "notes.txt"), "application/pdf");
        assert_eq!(sniff_mime(b"hello", "notes.txt"), "text/plain");
        assert!(!is_textual_mime("application/octet-stream"));
    }
}
