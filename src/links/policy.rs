use crate::error::AppError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedUrl {
    pub url: String,
    pub host: String,
}
pub fn normalize_url(value: &str) -> Result<NormalizedUrl, AppError> {
    let raw = value.trim();
    let mut parsed = raw
        .parse::<tauri::Url>()
        .map_err(|_| AppError::Validation("Die Adresse ist keine gültige URL.".to_owned()))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Validation(
            "Nur HTTPS-Links sind erlaubt.".to_owned(),
        ));
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Validation(
            "Links mit Zugangsdaten sind nicht erlaubt.".to_owned(),
        ));
    }
    if parsed.port().is_some_and(|port| port != 443) {
        return Err(AppError::Validation(
            "Nur HTTPS-Port 443 ist erlaubt.".to_owned(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::Validation("Ungültiger URL-Host.".to_owned()))?
        .to_owned();
    parsed.set_fragment(None);
    if parsed.port() == Some(443) {
        parsed
            .set_port(None)
            .map_err(|_| AppError::Validation("Ungültiger URL-Port.".to_owned()))?;
    }
    Ok(NormalizedUrl {
        url: parsed.to_string(),
        host,
    })
}
pub fn is_public_address(address: &str) -> bool {
    let value = address
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split('%')
        .next()
        .unwrap_or("");
    if value.contains(':') {
        let Ok(ipv6) = value.parse::<std::net::Ipv6Addr>() else {
            return false;
        };
        if ipv6.is_unspecified() || ipv6.is_loopback() {
            return false;
        }
        let first = ipv6.segments()[0];
        if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || (first & 0xff00) == 0xff00 {
            return false;
        }
        if let Some(ipv4) = ipv6.to_ipv4_mapped() {
            return is_public_address(&ipv4.to_string());
        }
        return true;
    }
    let octets: Vec<_> = value
        .split('.')
        .filter_map(|v| v.parse::<u8>().ok())
        .collect();
    if octets.len() != 4 {
        return false;
    }
    let [a, b, c] = [octets[0], octets[1], octets[2]];
    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false;
    }
    if a == 100 && (64..=127).contains(&b)
        || a == 169 && b == 254
        || a == 172 && (16..=31).contains(&b)
        || a == 192 && b == 168
        || a == 198 && (b == 18 || b == 19)
        || a == 192 && b == 0 && c == 0
    {
        return false;
    }
    true
}
pub fn assert_public_url(value: &str) -> Result<NormalizedUrl, AppError> {
    let url = normalize_url(value)?;
    if value_is_literal_host(&url.host) && !is_public_address(&url.host) {
        return Err(AppError::Validation(
            "Diese Adresse ist aus Sicherheitsgründen nicht erreichbar.".to_owned(),
        ));
    }
    Ok(url)
}
fn value_is_literal_host(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok() || host.contains(':')
}

#[cfg(test)]
mod tests {
    use super::{assert_public_url, is_public_address, normalize_url};

    #[test]
    fn normalizes_idn_query_and_fragment() {
        assert_eq!(
            normalize_url("HTTPS://BÜCHER.Example:443/a?q=JIRA-42#details")
                .unwrap()
                .url,
            "https://xn--bcher-kva.example/a?q=JIRA-42"
        );
    }

    #[test]
    fn blocks_literal_private_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_address(address), "{address}");
        }
        assert!(is_public_address("8.8.8.8"));
        assert!(is_public_address("2606:4700:4700::1111"));
        assert!(assert_public_url("https://8.8.8.8/").is_ok());
        assert!(assert_public_url("https://127.0.0.1/").is_err());
    }
}
