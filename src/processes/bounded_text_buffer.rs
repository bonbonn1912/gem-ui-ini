use std::fmt;

/// Redacts the same diagnostic values as the Node process runner: sensitive
/// assignments, bearer credentials, and explicitly supplied secret values.
pub fn redact_diagnostic_text(value: &str, secret_values: &[String]) -> String {
    let mut redacted = redact_assignments(value);
    redacted = redact_bearer_tokens(&redacted);
    for secret in secret_values {
        if secret.encode_utf16().count() >= 6 {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
    }
    redacted
}

/// Keeps only the most recent bytes, so a noisy child cannot grow memory
/// forever.  Truncation is byte based, matching Node's Buffer behavior.
#[derive(Debug, Clone)]
pub struct BoundedTextBuffer {
    max_bytes: usize,
    bytes: Vec<u8>,
}

impl BoundedTextBuffer {
    pub fn new(max_bytes: usize) -> Result<Self, BoundedTextBufferError> {
        if max_bytes == 0 {
            return Err(BoundedTextBufferError);
        }
        Ok(Self {
            max_bytes,
            bytes: Vec::new(),
        })
    }

    pub fn with_default_limit() -> Self {
        Self {
            max_bytes: 64 * 1024,
            bytes: Vec::new(),
        }
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub fn append(&mut self, value: impl AsRef<[u8]>) {
        let value = value.as_ref();
        if value.len() >= self.max_bytes {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&value[value.len() - self.max_bytes..]);
            return;
        }
        self.bytes.extend_from_slice(value);
        let excess = self.bytes.len().saturating_sub(self.max_bytes);
        if excess > 0 {
            self.bytes.drain(..excess);
        }
    }

    pub fn clear(&mut self) {
        self.bytes.clear();
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn to_string_with_secrets(&self, secret_values: &[String]) -> String {
        redact_diagnostic_text(&self.to_string(), secret_values)
    }
}

impl fmt::Display for BoundedTextBuffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&String::from_utf8_lossy(&self.bytes))
    }
}

impl Default for BoundedTextBuffer {
    fn default() -> Self {
        Self::with_default_limit()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundedTextBufferError;

impl fmt::Display for BoundedTextBufferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("maxBytes must be a positive safe integer")
    }
}

impl std::error::Error for BoundedTextBufferError {}

pub fn environment_secrets<I, K, V>(environment: I) -> Vec<String>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    environment
        .into_iter()
        .filter_map(|(name, value)| {
            let name = name.as_ref();
            let value = value.as_ref();
            (!value.is_empty() && contains_secret_name(name)).then(|| value.to_string())
        })
        .collect()
}

fn contains_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "API-KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
    ]
    .iter()
    .any(|part| upper.contains(part))
}

fn is_ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn sensitive_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "APIKEY",
        "API_KEY",
        "API-KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
    ]
    .iter()
    .any(|part| upper.contains(part))
}

fn redact_assignments(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if (index == 0 || !is_ascii_word(bytes[index - 1])) && is_ascii_word(bytes[index]) {
            let key_end = index
                + bytes[index..]
                    .iter()
                    .take_while(|byte| is_ascii_word(**byte))
                    .count();
            let key = &value[index..key_end];
            let mut equals = key_end;
            while let Some(character) = value[equals..].chars().next() {
                if !character.is_whitespace() {
                    break;
                }
                equals += character.len_utf8();
            }
            if bytes.get(equals) == Some(&b'=') {
                equals += 1;
                while let Some(character) = value[equals..].chars().next() {
                    if !character.is_whitespace() {
                        break;
                    }
                    equals += character.len_utf8();
                }
                let mut value_end = equals;
                while let Some(character) = value[value_end..].chars().next() {
                    if character.is_whitespace() || character == ',' || character == ';' {
                        break;
                    }
                    value_end += character.len_utf8();
                }
                if sensitive_key(key) && value_end > equals {
                    output.push_str(&value[cursor..index]);
                    output.push_str(key);
                    output.push_str("=[REDACTED]");
                    cursor = value_end;
                    index = value_end;
                    continue;
                }
            }
        }
        index += 1;
    }
    output.push_str(&value[cursor..]);
    output
}

fn redact_bearer_tokens(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if (index == 0 || !is_ascii_word(bytes[index - 1]))
            && (bytes[index] == b'B' || bytes[index] == b'b')
            && bytes[index..].len() >= 6
            && value[index..index + 6].eq_ignore_ascii_case("Bearer")
        {
            let token_start = index + 6;
            let mut whitespace_end = token_start;
            while let Some(character) = value[whitespace_end..].chars().next() {
                if !character.is_whitespace() {
                    break;
                }
                whitespace_end += character.len_utf8();
            }
            if whitespace_end > token_start {
                let mut token_end = whitespace_end;
                while let Some(character) = value[token_end..].chars().next() {
                    if !character.is_ascii()
                        || !character.is_ascii_alphanumeric() && !"._~+/=-".contains(character)
                    {
                        break;
                    }
                    token_end += character.len_utf8();
                }
                if token_end > whitespace_end {
                    output.push_str(&value[cursor..index]);
                    output.push_str("Bearer [REDACTED]");
                    cursor = token_end;
                    index = token_end;
                    continue;
                }
            }
        }
        index += 1;
    }
    output.push_str(&value[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_only_newest_bytes() {
        let mut buffer = BoundedTextBuffer::new(8).unwrap();
        buffer.append("12345");
        buffer.append("67890");
        assert_eq!(buffer.to_string(), "34567890");
    }

    #[test]
    fn redacts_assignments_bearer_and_explicit_secrets() {
        assert_eq!(
            redact_diagnostic_text(
                "GEMINI_API_KEY=secret-value Bearer abc.def token-is-here",
                &["token-is-here".into()],
            ),
            "GEMINI_API_KEY=[REDACTED] Bearer [REDACTED] [REDACTED]"
        );
    }
}
