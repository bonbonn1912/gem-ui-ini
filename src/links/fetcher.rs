use super::policy::assert_public_url;
use crate::error::AppError;
#[cfg(feature = "reqwest-client")]
use std::io::Read;
use std::sync::Arc;

pub const PAGE_BYTES_LIMIT: usize = 512 * 1024;
pub const IMAGE_BYTES_LIMIT: usize = 2 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug)]
pub struct LinkImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub extension: String,
}

#[derive(Clone, Debug)]
pub struct LinkMetadata {
    pub final_url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
    pub unauthorized: bool,
    pub image: Option<LinkImage>,
}

pub trait LinkMetadataFetcher: Send + Sync {
    fn fetch(&self, value: &str) -> Result<LinkMetadata, AppError>;
}

#[derive(Clone)]
pub struct LinkMetadataFetcherService {
    pub inner: Arc<dyn LinkMetadataFetcher>,
}

impl Default for LinkMetadataFetcherService {
    fn default() -> Self {
        Self {
            inner: Arc::new(DisabledLinkMetadataFetcher),
        }
    }
}

impl LinkMetadataFetcherService {
    pub fn new(fetcher: Arc<dyn LinkMetadataFetcher>) -> Self {
        Self { inner: fetcher }
    }

    #[cfg(feature = "reqwest-client")]
    pub fn production() -> Result<Self, AppError> {
        Ok(Self::new(Arc::new(ReqwestLinkMetadataFetcher::new()?)))
    }
}

#[derive(Default)]
pub struct DisabledLinkMetadataFetcher;
impl LinkMetadataFetcher for DisabledLinkMetadataFetcher {
    fn fetch(&self, value: &str) -> Result<LinkMetadata, AppError> {
        let url = assert_public_url(value)?;
        Err(AppError::Upstream(format!(
            "Link-Vorschau ist ohne HTTP-Client deaktiviert ({})",
            url.host
        )))
    }
}

/// Bounded HTTPS-only OpenGraph transport. Production builds enable the
/// `reqwest-client` feature and construct this through `production()`.
#[cfg(feature = "reqwest-client")]
#[derive(Clone)]
pub struct ReqwestLinkMetadataFetcher {
    client: reqwest::blocking::Client,
}

#[cfg(feature = "reqwest-client")]
impl ReqwestLinkMetadataFetcher {
    pub fn new() -> Result<Self, AppError> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("gem-ui/1.0 link-preview")
            .build()
            .map_err(|error| {
                AppError::Internal(format!("HTTP-Client konnte nicht erstellt werden: {error}"))
            })?;
        Ok(Self { client })
    }

    fn fetch_bounded(
        &self,
        value: &str,
        limit: usize,
    ) -> Result<(String, Vec<u8>, u16, Option<String>), AppError> {
        let mut current = assert_public_url(value)?.url;
        for redirect in 0..=MAX_REDIRECTS {
            assert_public_dns(&current)?;
            let mut response = self.client.get(&current).send().map_err(|error| {
                AppError::Upstream(format!("Link konnte nicht geladen werden: {error}"))
            })?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                if redirect == MAX_REDIRECTS {
                    return Err(AppError::Upstream(
                        "Zu viele Link-Weiterleitungen.".to_owned(),
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|header| header.to_str().ok())
                    .ok_or_else(|| {
                        AppError::Upstream("Weiterleitung ohne gültiges Ziel.".to_owned())
                    })?;
                current = resolve_redirect(&current, location)?;
                continue;
            }
            if response
                .content_length()
                .is_some_and(|length| length > limit as u64)
            {
                return Err(AppError::Validation(
                    "Die Linkantwort ist zu groß.".to_owned(),
                ));
            }
            let mut bytes = Vec::new();
            response
                .by_ref()
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| {
                    AppError::Upstream(format!("Linkantwort konnte nicht gelesen werden: {error}"))
                })?;
            if bytes.len() > limit {
                return Err(AppError::Validation(
                    "Die Linkantwort ist zu groß.".to_owned(),
                ));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(|value| value.trim().to_ascii_lowercase());
            return Ok((current, bytes, status, content_type));
        }
        Err(AppError::Upstream(
            "Link-Weiterleitung fehlgeschlagen.".to_owned(),
        ))
    }
}

#[cfg(feature = "reqwest-client")]
impl LinkMetadataFetcher for ReqwestLinkMetadataFetcher {
    fn fetch(&self, value: &str) -> Result<LinkMetadata, AppError> {
        let (final_url, page, status, content_type) =
            self.fetch_bounded(value, PAGE_BYTES_LIMIT)?;
        if status == 401 || status == 403 {
            return Ok(LinkMetadata {
                final_url,
                title: None,
                description: None,
                site_name: None,
                image_url: None,
                unauthorized: true,
                image: None,
            });
        }
        if !(200..300).contains(&status) {
            return Err(AppError::Upstream(format!(
                "Link antwortete mit HTTP {status}."
            )));
        }
        if !matches!(
            content_type.as_deref(),
            Some("text/html") | Some("application/xhtml+xml")
        ) {
            return Err(AppError::Validation(
                "Die Adresse liefert keine HTML-Seite.".to_owned(),
            ));
        }
        let parsed = super::html::parse_html_metadata(&String::from_utf8_lossy(&page), &final_url);
        let unauthorized = looks_like_login(&final_url, parsed.title.as_deref());
        let image = if unauthorized {
            None
        } else {
            parsed.image_url.as_deref().and_then(|image_url| {
                self.fetch_bounded(image_url, IMAGE_BYTES_LIMIT)
                    .ok()
                    .and_then(|(_, bytes, status, _)| {
                        if !(200..300).contains(&status) {
                            return None;
                        }
                        let (mime_type, extension) = detect_image(&bytes)?;
                        Some(LinkImage {
                            bytes,
                            mime_type: mime_type.to_owned(),
                            extension: extension.to_owned(),
                        })
                    })
            })
        };
        Ok(LinkMetadata {
            final_url,
            title: parsed.title,
            description: parsed.description,
            site_name: parsed.site_name,
            image_url: parsed.image_url,
            unauthorized,
            image,
        })
    }
}

#[cfg(feature = "reqwest-client")]
fn resolve_redirect(current: &str, location: &str) -> Result<String, AppError> {
    let location = location.trim();
    let candidate = if location.starts_with("//") {
        format!("https:{location}")
    } else if location.starts_with('/') {
        let origin = current.split('/').take(3).collect::<Vec<_>>().join("/");
        format!("{origin}{location}")
    } else {
        location.to_owned()
    };
    Ok(assert_public_url(&candidate)?.url)
}

#[cfg(feature = "reqwest-client")]
fn assert_public_dns(value: &str) -> Result<(), AppError> {
    use std::net::ToSocketAddrs;
    let host = assert_public_url(value)?.host;
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    let addresses = (host.as_str(), 443).to_socket_addrs().map_err(|_| {
        AppError::Validation("Der Link-Host konnte nicht aufgelöst werden.".to_owned())
    })?;
    let mut found = false;
    for address in addresses {
        found = true;
        if !super::policy::is_public_address(&address.ip().to_string()) {
            return Err(AppError::Validation(
                "Der Link-Host zeigt auf ein nicht öffentliches Netz.".to_owned(),
            ));
        }
    }
    if found {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Der Link-Host konnte nicht aufgelöst werden.".to_owned(),
        ))
    }
}

#[cfg(feature = "reqwest-client")]
fn detect_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

#[cfg(feature = "reqwest-client")]
fn looks_like_login(url: &str, title: Option<&str>) -> bool {
    let value = format!(
        "{} {}",
        url.to_ascii_lowercase(),
        title.unwrap_or_default().to_ascii_lowercase()
    );
    ["login", "sign-in", "signin", "anmelden", "auth"]
        .iter()
        .any(|needle| value.contains(needle))
}
