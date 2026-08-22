use super::policy::normalize_url;
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HtmlMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
}

pub fn parse_html_metadata(html: &str, page_url: &str) -> HtmlMetadata {
    let mut result = HtmlMetadata {
        title: tag_text(html, "title").map(|value| clean(&value, 300)),
        ..Default::default()
    };
    let mut cursor = 0;
    while let Some(offset) = html[cursor..].find('<') {
        let start = cursor + offset;
        let end = match html[start..].find('>') {
            Some(offset) => start + offset,
            None => break,
        };
        let tag = &html[start..=end];
        let lower = tag.to_ascii_lowercase();
        let attrs = attributes(tag);
        if lower.starts_with("<meta") {
            let key = attrs
                .get("property")
                .or_else(|| attrs.get("name"))
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if let Some(content) = attrs.get("content") {
                if key == "og:title" || (key == "twitter:title" && result.title.is_none()) {
                    result.title = Some(clean(content, 300));
                }
                if (key == "og:description" || key == "twitter:description" || key == "description")
                    && result.description.is_none()
                {
                    result.description = Some(clean(content, 1_000));
                }
                if key == "og:site_name" && result.site_name.is_none() {
                    result.site_name = Some(clean(content, 200));
                }
                if (key == "og:image" || key == "twitter:image" || key == "twitter:image:src")
                    && result.image_url.is_none()
                {
                    result.image_url = resolve_https(content, page_url);
                }
            }
        } else if lower.starts_with("<link")
            && result.image_url.is_none()
            && attrs
                .get("rel")
                .map(|value| {
                    value
                        .split_whitespace()
                        .any(|item| item.eq_ignore_ascii_case("icon"))
                })
                .unwrap_or(false)
        {
            if let Some(href) = attrs.get("href") {
                result.image_url = resolve_https(href, page_url);
            }
        }
        cursor = end + 1;
    }
    result
}

fn attributes(tag: &str) -> HashMap<String, String> {
    let bytes = tag.as_bytes();
    let mut result = HashMap::new();
    let mut index = 1;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'/') {
            index += 1;
        }
        let name_start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b':' | b'-' | b'_'))
        {
            index += 1;
        }
        if index == name_start {
            index += 1;
            continue;
        }
        let name = String::from_utf8_lossy(&bytes[name_start..index]).to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let value = if matches!(bytes.get(index), Some(b'"') | Some(b'\'')) {
            let quote = bytes[index];
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            let value = String::from_utf8_lossy(&bytes[start..index]).into_owned();
            if index < bytes.len() {
                index += 1;
            }
            value
        } else {
            let start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
            {
                index += 1;
            }
            String::from_utf8_lossy(&bytes[start..index]).into_owned()
        };
        result.insert(name, decode(&value));
    }
    result
}
fn tag_text(html: &str, name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find(&format!("<{name}"))?;
    let begin = lower[open..].find('>')? + open + 1;
    let close = lower[begin..].find(&format!("</{name}"))? + begin;
    Some(html[begin..close].to_owned())
}
fn clean(value: &str, limit: usize) -> String {
    decode(value)
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}
fn decode(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
fn resolve_https(value: &str, page: &str) -> Option<String> {
    let candidate = if value.starts_with("https://") {
        value.to_owned()
    } else if value.starts_with('/') {
        let base = page.split('/').take(3).collect::<Vec<_>>().join("/");
        format!("{base}{value}")
    } else {
        return None;
    };
    normalize_url(&candidate).ok().map(|value| value.url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_quoted_attributes_with_spaces() {
        let value = parse_html_metadata(
            r#"<title>Fallback</title><meta property="og:title" content="Ticket &amp; Details"><meta property="og:description" content="Eine Beschreibung"><meta property="og:image" content="/preview.png">"#,
            "https://jira.example.com/browse/42",
        );
        assert_eq!(value.title.as_deref(), Some("Ticket & Details"));
        assert_eq!(value.description.as_deref(), Some("Eine Beschreibung"));
        assert_eq!(
            value.image_url.as_deref(),
            Some("https://jira.example.com/preview.png")
        );
    }
}
