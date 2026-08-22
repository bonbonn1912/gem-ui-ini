use serde::{Deserialize, Serialize};
use std::fmt;

const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedGitBranch {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedGitStatusEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflict: bool,
    pub untracked: bool,
    pub ignored: bool,
    pub submodule: bool,
    pub rename_score: Option<u8>,
    pub head_oid: Option<String>,
    pub index_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedGitStatus {
    pub branch: ParsedGitBranch,
    pub entries: Vec<ParsedGitStatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PorcelainV2Error {
    InvalidPath,
    InvalidOrdinaryRecord,
    InvalidRenameRecord,
    InvalidUnmergedRecord,
    MissingRenamePath,
    InvalidXyStatus,
    UnsupportedRecord(char),
}

impl fmt::Display for PorcelainV2Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("Invalid Git path"),
            Self::InvalidOrdinaryRecord => f.write_str("Invalid porcelain v2 ordinary record"),
            Self::InvalidRenameRecord => f.write_str("Invalid porcelain v2 rename record"),
            Self::InvalidUnmergedRecord => f.write_str("Invalid porcelain v2 unmerged record"),
            Self::MissingRenamePath => f.write_str("Rename record has no original path"),
            Self::InvalidXyStatus => f.write_str("Invalid porcelain v2 XY status"),
            Self::UnsupportedRecord(kind) => write!(f, "Unsupported porcelain v2 record: {kind}"),
        }
    }
}

impl std::error::Error for PorcelainV2Error {}

/// Parses NUL-separated `git status --porcelain=v2 -z` output.
pub fn parse_porcelain_v2(input: impl AsRef<[u8]>) -> Result<ParsedGitStatus, PorcelainV2Error> {
    // Node's Buffer#toString("utf8") replaces malformed sequences.  The
    // lossy conversion keeps that observable behavior for CLI output.
    let text = String::from_utf8_lossy(input.as_ref());
    let records: Vec<&str> = text.split('\0').collect();
    let mut branch = ParsedGitBranch {
        oid: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    let mut entries = Vec::new();
    let mut index = 0usize;

    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }

        if let Some(value) = record.strip_prefix("# ") {
            parse_branch_header(value, &mut branch);
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            entries.push(ParsedGitStatusEntry {
                path: assert_git_path(path)?,
                previous_path: None,
                index_status: ".".into(),
                worktree_status: "?".into(),
                conflict: false,
                untracked: true,
                ignored: false,
                submodule: false,
                rename_score: None,
                head_oid: None,
                index_oid: None,
            });
            continue;
        }
        if let Some(path) = record.strip_prefix("! ") {
            entries.push(ParsedGitStatusEntry {
                path: assert_git_path(path)?,
                previous_path: None,
                index_status: ".".into(),
                worktree_status: "!".into(),
                conflict: false,
                untracked: false,
                ignored: true,
                submodule: false,
                rename_score: None,
                head_oid: None,
                index_oid: None,
            });
            continue;
        }
        if record.starts_with("1 ") {
            let fields = split_fields(record, 8);
            if fields.len() != 9 {
                return Err(PorcelainV2Error::InvalidOrdinaryRecord);
            }
            let xy = parse_xy(fields.get(1).copied())?;
            entries.push(ParsedGitStatusEntry {
                path: assert_git_path(fields[8])?,
                previous_path: None,
                index_status: xy[0].to_string(),
                worktree_status: xy[1].to_string(),
                conflict: is_conflict(xy),
                untracked: false,
                ignored: false,
                submodule: is_submodule(fields.get(2).copied()),
                rename_score: None,
                head_oid: fields.get(6).map(|value| (*value).to_string()),
                index_oid: fields.get(7).map(|value| (*value).to_string()),
            });
            continue;
        }
        if record.starts_with("2 ") {
            let fields = split_fields(record, 9);
            if fields.len() != 10 {
                return Err(PorcelainV2Error::InvalidRenameRecord);
            }
            let previous_path = records
                .get(index)
                .ok_or(PorcelainV2Error::MissingRenamePath)?;
            index += 1;
            let xy = parse_xy(fields.get(1).copied())?;
            let rename_score = fields.get(8).and_then(|value| {
                let score = value
                    .strip_prefix('R')
                    .or_else(|| value.strip_prefix('C'))?;
                if score.is_empty()
                    || score.len() > 3
                    || !score.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return None;
                }
                Some(score.parse::<u16>().ok()?.min(100) as u8)
            });
            entries.push(ParsedGitStatusEntry {
                path: assert_git_path(fields[9])?,
                previous_path: Some(assert_git_path(previous_path)?),
                index_status: xy[0].to_string(),
                worktree_status: xy[1].to_string(),
                conflict: is_conflict(xy),
                untracked: false,
                ignored: false,
                submodule: is_submodule(fields.get(2).copied()),
                rename_score,
                head_oid: fields.get(6).map(|value| (*value).to_string()),
                index_oid: fields.get(7).map(|value| (*value).to_string()),
            });
            continue;
        }
        if record.starts_with("u ") {
            let fields = split_fields(record, 10);
            if fields.len() != 11 {
                return Err(PorcelainV2Error::InvalidUnmergedRecord);
            }
            let xy = parse_xy(fields.get(1).copied())?;
            entries.push(ParsedGitStatusEntry {
                path: assert_git_path(fields[10])?,
                previous_path: None,
                index_status: xy[0].to_string(),
                worktree_status: xy[1].to_string(),
                conflict: true,
                untracked: false,
                ignored: false,
                submodule: is_submodule(fields.get(2).copied()),
                rename_score: None,
                head_oid: fields.get(7).map(|value| (*value).to_string()),
                index_oid: fields.get(9).map(|value| (*value).to_string()),
            });
            continue;
        }

        return Err(PorcelainV2Error::UnsupportedRecord(
            record.chars().next().unwrap_or('e'),
        ));
    }

    entries.retain(|entry| !entry.ignored);
    Ok(ParsedGitStatus { branch, entries })
}

fn parse_branch_header(value: &str, branch: &mut ParsedGitBranch) {
    let (key, content) = match value.find(' ') {
        Some(separator) => (&value[..separator], &value[separator + 1..]),
        None => (value, ""),
    };
    match key {
        "branch.oid" => branch.oid = (content != "(initial)").then(|| content.to_string()),
        "branch.head" => branch.head = (content != "(detached)").then(|| content.to_string()),
        "branch.upstream" => branch.upstream = (!content.is_empty()).then(|| content.to_string()),
        "branch.ab" => {
            let mut parts = content.split_whitespace();
            if let (Some(ahead), Some(behind), None) = (parts.next(), parts.next(), parts.next()) {
                if let (Some(ahead), Some(behind)) =
                    (ahead.strip_prefix('+'), behind.strip_prefix('-'))
                {
                    if let (Ok(ahead), Ok(behind)) = (ahead.parse(), behind.parse()) {
                        branch.ahead = ahead;
                        branch.behind = behind;
                    }
                }
            }
        }
        _ => {}
    }
}

fn split_fields(value: &str, separator_count: usize) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    for _ in 0..separator_count {
        let Some(relative) = value[start..].find(' ') else {
            return Vec::new();
        };
        let separator = start + relative;
        fields.push(&value[start..separator]);
        start = separator + 1;
    }
    fields.push(&value[start..]);
    fields
}

fn parse_xy(value: Option<&str>) -> Result<[char; 2], PorcelainV2Error> {
    let Some(value) = value else {
        return Err(PorcelainV2Error::InvalidXyStatus);
    };
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(PorcelainV2Error::InvalidXyStatus);
    };
    let Some(second) = chars.next() else {
        return Err(PorcelainV2Error::InvalidXyStatus);
    };
    if chars.next().is_some() || !".MADRCUT".contains(first) || !".MADRCUT".contains(second) {
        return Err(PorcelainV2Error::InvalidXyStatus);
    }
    Ok([first, second])
}

fn is_conflict(xy: [char; 2]) -> bool {
    let value = [xy[0], xy[1]].iter().collect::<String>();
    CONFLICT_CODES.contains(&value.as_str())
}

fn is_submodule(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    value.chars().count() == 4 && value.starts_with('S')
}

fn assert_git_path(value: &str) -> Result<String, PorcelainV2Error> {
    if value.is_empty() || value.contains('\0') {
        return Err(PorcelainV2Error::InvalidPath);
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_ordinary_rename_conflict_and_untracked_records() {
        let hash_a = "a".repeat(40);
        let hash_b = "b".repeat(40);
        let input = [
            format!("# branch.oid {hash_a}"),
            "# branch.head feature/diff".into(),
            "# branch.upstream origin/feature/diff".into(),
            "# branch.ab +3 -2".into(),
            format!("1 MM N... 100644 100644 100644 {hash_a} {hash_b} src/a file.ts"),
            format!("2 R. N... 100644 100644 100644 {hash_a} {hash_b} R087 src/new name.ts"),
            "src/old name.ts".into(),
            format!(
                "u UU N... 100644 100644 100644 100644 {hash_a} {hash_a} {hash_b} conflicted.ts"
            ),
            "? weird\tunicode-ä.txt".into(),
            "".into(),
        ]
        .join("\0");

        let status = parse_porcelain_v2(input).unwrap();
        assert_eq!(
            status.branch,
            ParsedGitBranch {
                oid: Some(hash_a.clone()),
                head: Some("feature/diff".into()),
                upstream: Some("origin/feature/diff".into()),
                ahead: 3,
                behind: 2,
            }
        );
        assert_eq!(status.entries.len(), 4);
        assert_eq!(status.entries[0].path, "src/a file.ts");
        assert_eq!(
            status.entries[1].previous_path.as_deref(),
            Some("src/old name.ts")
        );
        assert_eq!(status.entries[1].rename_score, Some(87));
        assert!(status.entries[2].conflict);
        assert_eq!(status.entries[3].path, "weird\tunicode-ä.txt");
    }

    #[test]
    fn filters_ignored_entries() {
        let status = parse_porcelain_v2("! ignored\0? shown\0").unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "shown");
    }
}
