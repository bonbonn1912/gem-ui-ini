use std::fmt;

/// Pass-through guard that terminates a protocol stream with an oversized
/// line.  Newlines themselves are not counted toward the limit.
#[derive(Debug, Clone)]
pub struct NdjsonLineGuard {
    pub max_line_bytes: usize,
    current_line_bytes: usize,
}

impl NdjsonLineGuard {
    pub fn new(max_line_bytes: usize) -> Result<Self, NdjsonLineGuardError> {
        if max_line_bytes == 0 {
            return Err(NdjsonLineGuardError::InvalidLimit);
        }
        Ok(Self {
            max_line_bytes,
            current_line_bytes: 0,
        })
    }

    pub fn current_line_bytes(&self) -> usize {
        self.current_line_bytes
    }

    /// Returns the original chunk on success.  On an oversized line the
    /// complete chunk is rejected, matching Node Transform callback behavior.
    pub fn process(&mut self, chunk: &[u8]) -> Result<Vec<u8>, NdjsonLineGuardError> {
        for byte in chunk {
            if *byte == b'\n' {
                self.current_line_bytes = 0;
            } else {
                self.current_line_bytes += 1;
                if self.current_line_bytes > self.max_line_bytes {
                    return Err(NdjsonLineGuardError::LineTooLong {
                        max_line_bytes: self.max_line_bytes,
                    });
                }
            }
        }
        Ok(chunk.to_vec())
    }
}

impl Default for NdjsonLineGuard {
    fn default() -> Self {
        Self {
            max_line_bytes: 32 * 1024 * 1024,
            current_line_bytes: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NdjsonLineGuardError {
    InvalidLimit,
    LineTooLong { max_line_bytes: usize },
}

impl fmt::Display for NdjsonLineGuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit => f.write_str("maxLineBytes must be a positive safe integer"),
            Self::LineTooLong { max_line_bytes } => {
                write!(f, "ACP protocol line exceeded {max_line_bytes} bytes")
            }
        }
    }
}

impl std::error::Error for NdjsonLineGuardError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resets_count_at_newline_and_passes_chunks_through() {
        let mut guard = NdjsonLineGuard::new(3).unwrap();
        assert_eq!(guard.process(b"ab").unwrap(), b"ab");
        assert_eq!(guard.process(b"c\nxyz").unwrap(), b"c\nxyz");
        assert_eq!(guard.current_line_bytes(), 3);
    }

    #[test]
    fn rejects_line_that_exceeds_limit() {
        let mut guard = NdjsonLineGuard::new(3).unwrap();
        assert!(matches!(
            guard.process(b"abcd"),
            Err(NdjsonLineGuardError::LineTooLong { max_line_bytes: 3 })
        ));
    }
}
