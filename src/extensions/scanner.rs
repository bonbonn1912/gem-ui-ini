//! Bounded scanner for Gemini skills and MCP settings.

use crate::error::AppError;
use crate::git::now_iso;
use crate::projects::ProjectService;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MAX_GEMINI_SKILLS: usize = 500;
pub const MAX_MCP_SERVERS: usize = 200;
pub const MAX_SCAN_PATHS: usize = 48;
const MAX_SKILL_BYTES: u64 = 512 * 1024;
const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionScope {
    Builtin,
    User,
    Project,
    System,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub scope: ExtensionScope,
    pub scope_label: Option<String>,
    pub path: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSkillList {
    pub project_id: Option<String>,
    pub refreshed_at: String,
    pub skills: Vec<GeminiSkill>,
    pub scanned_paths: Vec<String>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub scope: ExtensionScope,
    pub scope_label: Option<String>,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub cwd: Option<String>,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub description: Option<String>,
    pub trusted: bool,
    pub enabled: bool,
    pub config_path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerList {
    pub project_id: Option<String>,
    pub refreshed_at: String,
    pub servers: Vec<McpServer>,
    pub scanned_paths: Vec<String>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAgentExtensionsInput {
    pub project_id: Option<String>,
}

pub struct AgentExtensionService {
    projects: Arc<ProjectService>,
}
impl AgentExtensionService {
    pub fn new(projects: Arc<ProjectService>) -> Self {
        Self { projects }
    }
    pub fn list_skills(
        &self,
        input: ListAgentExtensionsInput,
    ) -> Result<GeminiSkillList, AppError> {
        let mut targets = self.skill_targets(input.project_id.as_deref());
        targets.truncate(MAX_SCAN_PATHS);
        let disabled = self.disabled_names(input.project_id.as_deref());
        let mut by_name: HashMap<String, (usize, GeminiSkill)> = HashMap::new();
        let mut truncated = false;
        for (rank, scope, label, dir) in targets.drain(..) {
            let entries = fs::read_dir(&dir)
                .ok()
                .map(|value| {
                    value
                        .filter_map(Result::ok)
                        .filter(|value| {
                            value
                                .file_type()
                                .map(|v| v.is_dir() || v.is_symlink())
                                .unwrap_or(false)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for item in entries.iter().take(400) {
                let skill_file = item.path().join("SKILL.md");
                let Some(metadata) = read_skill_metadata(&skill_file) else {
                    continue;
                };
                let name = metadata
                    .0
                    .clone()
                    .unwrap_or_else(|| item.file_name().to_string_lossy().into_owned())
                    .chars()
                    .take(200)
                    .collect::<String>();
                let enabled = !disabled.contains(&name.to_ascii_lowercase());
                if by_name.get(&name).is_some_and(|value| value.0 > rank) {
                    continue;
                }
                by_name.insert(
                    name.clone(),
                    (
                        rank,
                        GeminiSkill {
                            id: format!("{}:{name}", scope_name(&scope)),
                            name,
                            description: metadata.1.chars().take(4_000).collect(),
                            scope: scope.clone(),
                            scope_label: label.clone(),
                            path: item.path().to_string_lossy().into_owned(),
                            enabled,
                        },
                    ),
                );
            }
            if entries.len() > 400 {
                truncated = true;
            }
        }
        let mut skills = by_name
            .into_values()
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        skills.sort_by_key(|value| value.name.to_ascii_lowercase());
        if skills.len() > MAX_GEMINI_SKILLS {
            truncated = true;
            skills.truncate(MAX_GEMINI_SKILLS);
        }
        Ok(GeminiSkillList {
            project_id: input.project_id,
            refreshed_at: now_iso(),
            skills,
            scanned_paths: self
                .skill_targets(None)
                .into_iter()
                .map(|(_, _, _, path)| path.to_string_lossy().into_owned())
                .take(MAX_SCAN_PATHS)
                .collect(),
            truncated,
        })
    }
    pub fn list_mcp_servers(
        &self,
        input: ListAgentExtensionsInput,
    ) -> Result<McpServerList, AppError> {
        let targets = self
            .settings_targets(input.project_id.as_deref())
            .into_iter()
            .take(MAX_SCAN_PATHS)
            .collect::<Vec<_>>();
        let mut by_name: HashMap<String, (usize, McpServer)> = HashMap::new();
        let mut allowed = None;
        let mut excluded = None;
        for (rank, scope, label, dir) in &targets {
            let path = dir.join(".gemini/settings.json");
            let Some(document) = read_json(&path, MAX_SETTINGS_BYTES) else {
                continue;
            };
            if let Some(section) = document.get("mcp").and_then(Value::as_object) {
                allowed = read_strings(section.get("allowed"));
                excluded = read_strings(section.get("excluded"));
            }
            let Some(servers) = document.get("mcpServers").and_then(Value::as_object) else {
                continue;
            };
            for (name, definition) in servers {
                let Some(definition) = definition.as_object() else {
                    continue;
                };
                if by_name.get(name).is_some_and(|value| value.0 > *rank) {
                    continue;
                };
                by_name.insert(
                    name.clone(),
                    (
                        *rank,
                        describe_server(name, definition, scope.clone(), label.clone(), &path),
                    ),
                );
            }
        }
        let mut servers = by_name
            .into_values()
            .map(|(_, mut value)| {
                value.enabled = !excluded
                    .as_ref()
                    .is_some_and(|values| values.iter().any(|item| item == &value.name))
                    && allowed
                        .as_ref()
                        .map_or(true, |values| values.iter().any(|item| item == &value.name));
                value
            })
            .collect::<Vec<_>>();
        servers.sort_by_key(|value| value.name.to_ascii_lowercase());
        let truncated = servers.len() > MAX_MCP_SERVERS;
        servers.truncate(MAX_MCP_SERVERS);
        Ok(McpServerList {
            project_id: input.project_id,
            refreshed_at: now_iso(),
            servers,
            scanned_paths: targets
                .into_iter()
                .map(|(_, _, _, path)| {
                    path.join(".gemini/settings.json")
                        .to_string_lossy()
                        .into_owned()
                })
                .take(MAX_SCAN_PATHS)
                .collect(),
            truncated,
        })
    }
    fn skill_targets(
        &self,
        project_id: Option<&str>,
    ) -> Vec<(usize, ExtensionScope, Option<String>, PathBuf)> {
        let mut result = Vec::new();
        for (index, relative) in ["skills", "resources/skills"].iter().enumerate() {
            if let Some(executable) = std::env::current_exe()
                .ok()
                .and_then(|value| value.parent().map(Path::to_path_buf))
            {
                result.push((
                    index,
                    ExtensionScope::Builtin,
                    Some("Eingebaut".into()),
                    executable.join(relative),
                ));
            }
        }
        if let Some(home) = home_dir() {
            for (index, relative) in [".gemini/skills", ".agents/skills"].iter().enumerate() {
                result.push((
                    10 + index,
                    ExtensionScope::User,
                    Some("Benutzer".into()),
                    home.join(relative),
                ));
            }
        }
        for (index, base) in system_extension_bases().into_iter().enumerate() {
            result.push((
                20 + index,
                ExtensionScope::System,
                Some("System".into()),
                base.join("skills"),
            ));
        }
        if let Some(project_id) = project_id {
            if let Ok(project) = self.projects.get(project_id) {
                for (root_index, root) in project.roots.iter().enumerate() {
                    for (index, relative) in [".gemini/skills", ".agents/skills"].iter().enumerate()
                    {
                        result.push((
                            100 + root_index * 10 + index,
                            ExtensionScope::Project,
                            Some(root.label.clone()),
                            Path::new(&root.path).join(relative),
                        ));
                    }
                }
            }
        }
        result
    }
    fn settings_targets(
        &self,
        project_id: Option<&str>,
    ) -> Vec<(usize, ExtensionScope, Option<String>, PathBuf)> {
        let mut result = Vec::new();
        for (index, base) in system_extension_bases().into_iter().enumerate() {
            result.push((
                20 + index,
                ExtensionScope::System,
                Some("System".into()),
                base,
            ));
        }
        if let Some(home) = home_dir() {
            result.push((10, ExtensionScope::User, Some("Benutzer".into()), home));
        }
        if let Some(project_id) = project_id {
            if let Ok(project) = self.projects.get(project_id) {
                for (index, root) in project.roots.iter().enumerate() {
                    result.push((
                        100 + index,
                        ExtensionScope::Project,
                        Some(root.label.clone()),
                        PathBuf::from(&root.path),
                    ));
                }
            }
        }
        result
    }
    fn disabled_names(&self, project_id: Option<&str>) -> std::collections::HashSet<String> {
        let mut values = std::collections::HashSet::new();
        for (_, _, _, path) in self
            .settings_targets(project_id)
            .into_iter()
            .take(MAX_SCAN_PATHS)
        {
            if let Some(value) = read_json(&path.join(".gemini/settings.json"), MAX_SETTINGS_BYTES)
            {
                if let Some(skills) = value
                    .get("skills")
                    .and_then(Value::as_object)
                    .and_then(|v| read_strings(v.get("disabled")))
                {
                    values.extend(skills.into_iter().map(|v| v.to_ascii_lowercase()));
                }
            }
        }
        values
    }
}

fn system_extension_bases() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(windows) {
        if let Some(value) = std::env::var_os("PROGRAMDATA") {
            paths.push(PathBuf::from(value).join("gemini"));
        }
    } else {
        paths.push(PathBuf::from("/etc/gemini"));
        paths.push(PathBuf::from("/usr/local/share/gemini"));
        paths.push(PathBuf::from("/usr/share/gemini"));
    }
    paths
}

fn read_skill_metadata(path: &Path) -> Option<(Option<String>, String)> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_SKILL_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let result = parse_frontmatter(&text);
    Some((
        result.get("name").cloned(),
        result.get("description").cloned().unwrap_or_default(),
    ))
}

/// Parse the flat YAML front matter supported by Gemini's SKILL.md files.
/// Unknown fields are retained for forward compatibility; indented lines are
/// folded into the preceding scalar value.
pub fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let Some(body) = normalized
        .strip_prefix("---\n")
        .and_then(|value| value.split_once("\n---").map(|(body, _)| body))
    else {
        return HashMap::new();
    };
    let mut result = HashMap::new();
    let mut current: Option<String> = None;
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let top_level = !line
            .chars()
            .next()
            .is_some_and(|value| value.is_whitespace());
        if top_level {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim();
                if !key.is_empty() {
                    let value = value.trim();
                    result.insert(
                        key.to_owned(),
                        if matches!(value, "|" | ">" | "|-" | ">-") {
                            String::new()
                        } else {
                            unquote(value)
                        },
                    );
                    current = Some(key.to_owned());
                    continue;
                }
            }
        }
        if let Some(key) = &current {
            let value = line.trim();
            if !value.is_empty() {
                let entry = result.entry(key.clone()).or_default();
                if !entry.is_empty() {
                    entry.push(' ');
                }
                entry.push_str(value);
            }
        }
    }
    result
        .into_iter()
        .map(|(key, value)| (key, unquote(value.trim())))
        .collect()
}
fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        value[1..value.len() - 1].into()
    } else {
        value.into()
    }
}
fn read_json(path: &Path, max: u64) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > max {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let cleaned = strip_trailing_commas(&strip_comments(&text));
    serde_json::from_str(&cleaned)
        .or_else(|_| serde_json::from_str(&text))
        .ok()
}
fn strip_comments(text: &str) -> String {
    let mut output = String::new();
    let mut chars = text.chars().peekable();
    let mut string = false;
    while let Some(value) = chars.next() {
        if value == '"' {
            string = !string;
            output.push(value);
            continue;
        }
        if !string && value == '/' && chars.peek() == Some(&'/') {
            chars.next();
            while chars.next_if(|v| *v != '\n').is_some() {}
            output.push('\n');
            continue;
        }
        if !string && value == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(next) = chars.next() {
                if next == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
            continue;
        }
        output.push(value);
    }
    output
}
fn strip_trailing_commas(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let chars = text.chars().collect::<Vec<_>>();
    let mut string = false;
    let mut escaped = false;
    for (index, value) in chars.iter().copied().enumerate() {
        if value == '"' && !escaped {
            string = !string;
        }
        if !string && value == ',' {
            let mut next = index + 1;
            while next < chars.len() && chars[next].is_whitespace() {
                next += 1;
            }
            if next < chars.len() && matches!(chars[next], '}' | ']') {
                continue;
            }
        }
        output.push(value);
        escaped = value == '\\' && !escaped;
        if value != '\\' {
            escaped = false;
        }
    }
    output
}
fn read_strings(value: Option<&Value>) -> Option<Vec<String>> {
    value?.as_array().map(|values| {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}
fn describe_server(
    name: &str,
    value: &serde_json::Map<String, Value>,
    scope: ExtensionScope,
    label: Option<String>,
    path: &Path,
) -> McpServer {
    let http = value
        .get("httpUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let command = value
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let transport = if http.is_some() {
        McpTransport::Http
    } else if url.is_some() {
        McpTransport::Sse
    } else if command.is_some() {
        McpTransport::Stdio
    } else {
        McpTransport::Unknown
    };
    McpServer {
        id: format!("{}:{name}", scope_name(&scope)),
        name: name.chars().take(200).collect(),
        scope,
        scope_label: label,
        transport,
        command: command.map(|value| value.chars().take(4_096).collect()),
        args: value
            .get("args")
            .and_then(|v| v.as_array())
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .take(64)
                    .map(redact_argument)
                    .map(|value| value.chars().take(4_096).collect())
                    .collect()
            })
            .unwrap_or_default(),
        url: sanitize_url(http.or(url)),
        cwd: value.get("cwd").and_then(Value::as_str).map(str::to_owned),
        env_keys: keys(value.get("env")),
        header_keys: keys(value.get("headers")),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(2_000).collect()),
        trusted: value.get("trust").and_then(Value::as_bool).unwrap_or(false),
        enabled: true,
        config_path: path.to_string_lossy().into_owned(),
    }
}
fn keys(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|v| {
            v.keys()
                .take(64)
                .map(|key| key.chars().take(200).collect())
                .collect()
        })
        .unwrap_or_default()
}
fn redact_argument(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if value.starts_with('-')
        && lower.split('=').next().is_some_and(|v| {
            ["token", "key", "secret", "password", "auth", "credential"]
                .iter()
                .any(|part| v.contains(part))
        })
    {
        format!("{}=•••", value.split('=').next().unwrap_or(value))
    } else {
        value.to_owned()
    }
}
fn sanitize_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
        .unwrap_or_default();
    if authority.contains('@') {
        return None;
    }
    let value = value.split(['?', '#']).next().unwrap_or(value);
    (!value.is_empty()).then(|| value.chars().take(4096).collect())
}
fn scope_name(value: &ExtensionScope) -> &'static str {
    match value {
        ExtensionScope::Builtin => "builtin",
        ExtensionScope::User => "user",
        ExtensionScope::Project => "project",
        ExtensionScope::System => "system",
    }
}
fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|v| !v.as_os_str().is_empty())
}
