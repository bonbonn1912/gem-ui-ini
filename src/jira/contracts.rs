use serde::{Deserialize, Serialize};

pub const MAX_JIRA_ISSUE_PREFIXES: usize = 25;
pub const MAX_JIRA_ISSUE_KEY_LENGTH: usize = 60;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub issue_prefixes: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraProjectIntegration {
    pub project_id: String,
    pub active_config_id: Option<String>,
    pub active_config: Option<JiraConfig>,
    pub updated_at: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveJiraConfigInput {
    pub client_request_id: String,
    pub config_id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub issue_prefixes: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteJiraConfigInput {
    pub client_request_id: String,
    pub config_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateJiraProjectIntegrationInput {
    pub client_request_id: String,
    pub project_id: String,
    pub config_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeactivateJiraProjectIntegrationInput {
    pub client_request_id: String,
    pub project_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetJiraProjectIntegrationInput {
    pub project_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachJiraIssueInput {
    pub client_request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub issue_key: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraIssueMatch {
    pub issue_key: String,
    pub prefix: String,
    pub url: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachJiraIssueResult {
    pub r#match: JiraIssueMatch,
    pub attachment_id: String,
}

pub fn normalize_prefix(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    if value.is_empty()
        || value.len() > 20
        || !value.as_bytes()[0].is_ascii_uppercase()
        || !value
            .bytes()
            .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_')
    {
        return Err("Jira-Prefix ist ungültig.".into());
    }
    Ok(value)
}
pub fn normalize_jira_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
        .unwrap_or_default();
    if value.is_empty()
        || !value.get(..7).is_some_and(|scheme| {
            scheme.eq_ignore_ascii_case("http://")
                || value
                    .get(..8)
                    .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        })
        || authority.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || value.contains('@')
        || value.contains('?')
        || value.contains('#')
    {
        return Err("Jira-URLs müssen sichere HTTPS-URLs ohne Benutzerdaten sein.".into());
    }
    Ok(value.to_owned())
}
pub fn normalize_issue_key(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    let Some((prefix, number)) = value.split_once('-') else {
        return Err("Erwartet wird ein Jira-Issue-Key wie AML-1234.".into());
    };
    let prefix = normalize_prefix(prefix)?;
    if number.is_empty()
        || number.len() > 12
        || !number.bytes().all(|v| v.is_ascii_digit())
        || value.len() > MAX_JIRA_ISSUE_KEY_LENGTH
    {
        return Err("Erwartet wird ein Jira-Issue-Key wie AML-1234.".into());
    }
    Ok(format!("{prefix}-{number}"))
}

pub fn match_jira_issue_key(title: &str, prefixes: &[String]) -> Option<(String, String, usize)> {
    let bytes = title.as_bytes();
    let mut best = None;
    for raw in prefixes {
        let prefix = raw.trim().to_ascii_uppercase();
        if prefix.is_empty() {
            continue;
        }
        let mut offset = 0;
        while let Some(found) = title[offset..]
            .to_ascii_uppercase()
            .find(&format!("{prefix}-"))
        {
            let index = offset + found;
            let before_ok =
                index == 0 || !bytes[index - 1].is_ascii_alphanumeric() && bytes[index - 1] != b'_';
            let start = index + prefix.len() + 1;
            let end = title[start..]
                .bytes()
                .take_while(|v| v.is_ascii_digit())
                .count()
                + start;
            let after_ok = end == title.len()
                || !title.as_bytes()[end].is_ascii_alphanumeric() && title.as_bytes()[end] != b'_';
            let earlier = best.as_ref().map_or(true, |(_, _, prior)| index < *prior);
            if before_ok && end > start && end - start <= 12 && after_ok && earlier {
                best = Some((
                    format!("{prefix}-{}", &title[start..end]).to_ascii_uppercase(),
                    prefix.clone(),
                    index,
                ));
            }
            offset = index + prefix.len() + 1;
            if offset >= title.len() {
                break;
            }
        }
    }
    best
}
pub fn build_jira_issue_url(base_url: &str, issue_key: &str) -> String {
    format!(
        "{}/browse/{}",
        base_url.trim().trim_end_matches('/'),
        issue_key.trim().to_ascii_uppercase()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_first_position_not_config_order() {
        let values = vec!["AML".into(), "BUG".into()];
        assert_eq!(
            match_jira_issue_key("BUG-7 hängt an AML-1234", &values)
                .unwrap()
                .0,
            "BUG-7"
        );
        assert!(match_jira_issue_key("DEBUG-12", &["BUG".into()]).is_none());
    }

    #[test]
    fn jira_base_url_accepts_local_http_but_rejects_credentials() {
        assert_eq!(
            normalize_jira_base_url("http://jira.example.com/").unwrap(),
            "http://jira.example.com"
        );
        assert!(normalize_jira_base_url("https://user:secret@jira.example.com").is_err());
        assert_eq!(
            normalize_jira_base_url("https://jira.example.com/").unwrap(),
            "https://jira.example.com"
        );
    }
}
