//! Bounded, deterministic extraction. Text extraction never executes a file.
//! PDF parsing is delegated to `pdf-extract`, which supports compressed
//! content streams and common PDF font encodings.
use super::{
    contracts::{ExtractionState, MAX_CONTEXT_CHARS_PER_ATTACHMENT},
    mime::is_textual_mime,
};
use std::{fs, path::Path};

#[derive(Clone, Debug)]
pub struct ExtractionResult {
    pub state: ExtractionState,
    pub text: String,
    pub extracted_chars: Option<usize>,
    pub page_count: Option<usize>,
    pub error: Option<String>,
}

pub fn extract_file(path: &Path, mime: &str) -> ExtractionResult {
    let bytes = match fs::read(path) {
        Ok(value) => value,
        Err(error) => return failed(error.to_string()),
    };
    if is_textual_mime(mime) {
        return extract_text(&bytes);
    }
    if mime == "application/pdf" {
        return extract_pdf(&bytes);
    }
    ExtractionResult {
        state: ExtractionState::Unsupported,
        text: String::new(),
        extracted_chars: None,
        page_count: None,
        error: None,
    }
}
fn extract_text(bytes: &[u8]) -> ExtractionResult {
    let source = match std::str::from_utf8(bytes) {
        Ok(value) => value,
        Err(_) => return failed("Datei enthält keine gültige UTF-8-Kodierung".to_owned()),
    };
    let normalized = source
        .strip_prefix('\u{feff}')
        .unwrap_or(source)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let text: String = normalized
        .chars()
        .take(MAX_CONTEXT_CHARS_PER_ATTACHMENT)
        .collect();
    ExtractionResult {
        state: if text.trim().is_empty() {
            ExtractionState::Empty
        } else {
            ExtractionState::Ready
        },
        text,
        extracted_chars: Some(normalized.chars().count()),
        page_count: None,
        error: None,
    }
}
fn extract_pdf(bytes: &[u8]) -> ExtractionResult {
    if !bytes.starts_with(b"%PDF-") {
        return failed("Ungültige PDF-Datei".to_owned());
    }
    let text = match pdf_extract::extract_text_from_mem(bytes) {
        Ok(value) => value.replace("\r\n", "\n").replace('\r', "\n"),
        Err(error) => return failed(format!("PDF-Textextraktion fehlgeschlagen: {error}")),
    };
    let pages = text.matches('\u{000c}').count().saturating_add(1);
    let clipped: String = text
        .chars()
        .take(MAX_CONTEXT_CHARS_PER_ATTACHMENT)
        .collect();
    ExtractionResult {
        state: if clipped.trim().is_empty() {
            ExtractionState::Empty
        } else {
            ExtractionState::Ready
        },
        text: clipped,
        extracted_chars: Some(text.chars().count()),
        page_count: Some(pages),
        error: None,
    }
}
fn failed(error: String) -> ExtractionResult {
    ExtractionResult {
        state: ExtractionState::Failed,
        text: String::new(),
        extracted_chars: None,
        page_count: None,
        error: Some(error.chars().take(500).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_text_and_normalizes_newlines() {
        let path = std::env::temp_dir().join(format!("geminui-extract-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"hello\r\nworld").unwrap();
        let result = extract_file(&path, "text/plain");
        assert_eq!(result.state, ExtractionState::Ready);
        assert_eq!(result.text, "hello\nworld");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn extracts_text_from_a_flate_compressed_pdf_stream() {
        let compressed_stream: &[u8] = &[
            120, 156, 115, 10, 81, 208, 119, 51, 84, 48, 52, 82, 8, 73, 83, 48, 55, 2, 34, 3, 133,
            144, 20, 5, 13, 143, 212, 156, 156, 124, 133, 228, 252, 220, 130, 162, 212, 226, 226,
            212, 20, 133, 0, 23, 55, 77, 133, 144, 44, 5, 215, 16, 46, 0, 96, 224, 14, 41,
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for object in [
            b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n".as_slice(),
            b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n".as_slice(),
            b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n".as_slice(),
            b"4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n".as_slice(),
        ] {
            offsets.push(pdf.len());
            pdf.extend_from_slice(object);
        }
        offsets.push(pdf.len());
        pdf.extend_from_slice(
            format!(
                "5 0 obj << /Length {} /Filter /FlateDecode >> stream\n",
                compressed_stream.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(compressed_stream);
        pdf.extend_from_slice(b"\nendstream endobj\n");
        let xref = pdf.len();
        pdf.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!("trailer << /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        let path =
            std::env::temp_dir().join(format!("geminui-compressed-pdf-{}", uuid::Uuid::new_v4()));
        fs::write(&path, pdf).unwrap();
        let result = extract_file(&path, "application/pdf");
        let _ = fs::remove_file(path);
        assert_eq!(result.state, ExtractionState::Ready);
        assert!(result.text.contains("Hello compressed PDF"));
        assert!(result.page_count.is_some_and(|pages| pages >= 1));
    }
}
