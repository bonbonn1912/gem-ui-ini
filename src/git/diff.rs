use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_GIT_DIFF_HUNKS: usize = 2_000;
pub const MAX_GIT_DIFF_LINES: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub hunk_id: String,
    pub header: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

/// Contract-compatible names used by the rest of the Git domain.
pub type GitDiffLine = DiffLine;
pub type GitDiffHunk = DiffHunk;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedUnifiedDiff {
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
    pub metadata: Vec<String>,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffLineLimitError;

impl fmt::Display for DiffLineLimitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("The diff exceeds the safe parsed-line limit")
    }
}

impl std::error::Error for DiffLineLimitError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnifiedDiffError {
    InvalidHunkHeader,
    DiffLineLimit(DiffLineLimitError),
}

impl fmt::Display for UnifiedDiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHunkHeader => f.write_str("Invalid unified diff hunk header"),
            Self::DiffLineLimit(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for UnifiedDiffError {}

/// Parses a Git unified diff while retaining the same metadata and line caps
/// as the previous desktop implementation.
pub fn parse_unified_diff(input: impl AsRef<[u8]>) -> Result<ParsedUnifiedDiff, UnifiedDiffError> {
    let text = String::from_utf8_lossy(input.as_ref());
    let mut source_lines: Vec<&str> = text.split('\n').collect();
    if source_lines.last() == Some(&"") {
        source_lines.pop();
    }

    let mut metadata = Vec::new();
    let mut hunks = Vec::new();
    let mut binary = false;
    let mut additions = 0usize;
    let mut deletions = 0usize;
    let mut total_lines = 0usize;
    let mut index = 0usize;

    while index < source_lines.len() {
        let line = strip_terminal_cr(source_lines[index]);
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            binary = true;
            metadata.push(line.to_string());
            index += 1;
            continue;
        }
        if !line.starts_with("@@ ") {
            if is_display_metadata(line) && metadata.len() < 100 {
                metadata.push(line.to_string());
            }
            index += 1;
            continue;
        }

        let (old_start, old_lines, new_start, new_lines) =
            parse_hunk_header(line).ok_or(UnifiedDiffError::InvalidHunkHeader)?;
        if hunks.len() >= MAX_GIT_DIFF_HUNKS {
            return Err(UnifiedDiffError::DiffLineLimit(DiffLineLimitError));
        }
        let mut old_line = old_start;
        let mut new_line = new_start;
        let mut lines = Vec::new();
        index += 1;

        while index < source_lines.len() {
            let source = strip_terminal_cr(source_lines[index]);
            if source.starts_with("@@ ") || source.starts_with("diff --git ") {
                break;
            }
            let Some(prefix) = source.chars().next() else {
                break;
            };
            match prefix {
                ' ' => {
                    lines.push(DiffLine {
                        kind: DiffLineKind::Context,
                        content: source[1..].to_string(),
                        old_line: Some(old_line),
                        new_line: Some(new_line),
                    });
                    old_line += 1;
                    new_line += 1;
                }
                '+' => {
                    lines.push(DiffLine {
                        kind: DiffLineKind::Addition,
                        content: source[1..].to_string(),
                        old_line: None,
                        new_line: Some(new_line),
                    });
                    additions += 1;
                    new_line += 1;
                }
                '-' => {
                    lines.push(DiffLine {
                        kind: DiffLineKind::Deletion,
                        content: source[1..].to_string(),
                        old_line: Some(old_line),
                        new_line: None,
                    });
                    deletions += 1;
                    old_line += 1;
                }
                '\\' => {
                    lines.push(DiffLine {
                        kind: DiffLineKind::NoNewline,
                        content: source[1..].trim_start().to_string(),
                        old_line: None,
                        new_line: None,
                    });
                }
                _ => break,
            }
            total_lines += 1;
            if total_lines > MAX_GIT_DIFF_LINES {
                return Err(UnifiedDiffError::DiffLineLimit(DiffLineLimitError));
            }
            index += 1;
        }

        let hunk_id = sha256_hex(format!("{}\0{}", hunks.len(), line).as_bytes());
        hunks.push(DiffHunk {
            hunk_id,
            header: line.to_string(),
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines,
        });
    }

    Ok(ParsedUnifiedDiff {
        binary,
        additions,
        deletions,
        metadata,
        hunks,
    })
}

fn strip_terminal_cr(value: &str) -> &str {
    value.strip_suffix('\r').unwrap_or(value)
}

fn is_display_metadata(line: &str) -> bool {
    [
        "diff --git ",
        "index ",
        "--- ",
        "+++ ",
        "old mode ",
        "new mode ",
        "new file mode ",
        "deleted file mode ",
        "similarity index ",
        "dissimilarity index ",
        "rename from ",
        "rename to ",
        "copy from ",
        "copy to ",
        "Submodule ",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize, usize)> {
    let mut rest = line.strip_prefix("@@ -")?;
    let (old_start, consumed) = parse_ascii_number(rest)?;
    rest = &rest[consumed..];
    let old_lines = if let Some(after_comma) = rest.strip_prefix(',') {
        let (value, consumed) = parse_ascii_number(after_comma)?;
        rest = &after_comma[consumed..];
        value
    } else {
        1
    };
    rest = rest.strip_prefix(" +")?;
    let (new_start, consumed) = parse_ascii_number(rest)?;
    rest = &rest[consumed..];
    let new_lines = if let Some(after_comma) = rest.strip_prefix(',') {
        let (value, consumed) = parse_ascii_number(after_comma)?;
        rest = &after_comma[consumed..];
        value
    } else {
        1
    };
    rest.strip_prefix(" @@")?;
    Some((old_start, old_lines, new_start, new_lines))
}

fn parse_ascii_number(value: &str) -> Option<(usize, usize)> {
    let consumed = value
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if consumed == 0 {
        return None;
    }
    Some((value[..consumed].parse().ok()?, consumed))
}

// A small dependency-free SHA-256 implementation keeps this pure parser
// usable before the crate's dependency set is finalized.
fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut message = input.to_vec();
    let bit_len = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for block in message.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, bytes) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let x = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let y = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(x)
                .wrapping_add(words[index - 7])
                .wrapping_add(y);
        }
        let mut working = state;
        for index in 0..64 {
            let s1 = working[4].rotate_right(6)
                ^ working[4].rotate_right(11)
                ^ working[4].rotate_right(25);
            let choice = (working[4] & working[5]) ^ ((!working[4]) & working[6]);
            let temp1 = working[7]
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = working[0].rotate_right(2)
                ^ working[0].rotate_right(13)
                ^ working[0].rotate_right(22);
            let majority =
                (working[0] & working[1]) ^ (working[0] & working[2]) ^ (working[1] & working[2]);
            let temp2 = s0.wrapping_add(majority);
            working = [
                temp1.wrapping_add(temp2),
                working[0],
                working[1],
                working[2],
                working[3].wrapping_add(temp1),
                working[4],
                working[5],
                working[6],
            ];
        }
        for index in 0..8 {
            state[index] = state[index].wrapping_add(working[index]);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_line_numbers_and_no_newline_marker() {
        let hash_a = "a".repeat(40);
        let hash_b = "b".repeat(40);
        let diff = parse_unified_diff(
            [
                "diff --git a/demo.txt b/demo.txt".to_string(),
                format!("index {}..{} 100644", &hash_a[..7], &hash_b[..7]),
                "--- a/demo.txt".into(),
                "+++ b/demo.txt".into(),
                "@@ -1,2 +1,3 @@ title".into(),
                " same".into(),
                "-old".into(),
                "+new".into(),
                "+extra".into(),
                "\\ No newline at end of file".into(),
                "".into(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert!(!diff.binary);
        assert_eq!((diff.additions, diff.deletions), (2, 1));
        assert_eq!(
            diff.hunks[0].lines,
            vec![
                DiffLine {
                    kind: DiffLineKind::Context,
                    content: "same".into(),
                    old_line: Some(1),
                    new_line: Some(1)
                },
                DiffLine {
                    kind: DiffLineKind::Deletion,
                    content: "old".into(),
                    old_line: Some(2),
                    new_line: None
                },
                DiffLine {
                    kind: DiffLineKind::Addition,
                    content: "new".into(),
                    old_line: None,
                    new_line: Some(2)
                },
                DiffLine {
                    kind: DiffLineKind::Addition,
                    content: "extra".into(),
                    old_line: None,
                    new_line: Some(3)
                },
                DiffLine {
                    kind: DiffLineKind::NoNewline,
                    content: "No newline at end of file".into(),
                    old_line: None,
                    new_line: None
                },
            ]
        );
    }

    #[test]
    fn hunk_id_matches_sha256() {
        let diff = parse_unified_diff("@@ -1 +1 @@\n-old\n+new\n").unwrap();
        assert_eq!(
            diff.hunks[0].hunk_id,
            "9dbb4fac345355944dce474168f832e4cc1e1826047490b3b4a4e1ffce6912f6"
        );
    }
}
