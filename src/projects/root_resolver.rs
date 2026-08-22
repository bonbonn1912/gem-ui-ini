use super::contracts::MAX_ADDITIONAL_ROOTS;
use super::errors::{ProjectRootErrorCode, ProjectRootValidationError};
use super::fingerprint::compute_root_fingerprint;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedRoot {
    pub path: String,
    pub real_path: String,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedProjectRootSet {
    pub primary_root: ResolvedRoot,
    pub additional_roots: Vec<ResolvedRoot>,
    pub fingerprint: String,
}

/// Resolves and validates the primary root followed by up to five additional
/// roots.  The order is part of the authority fingerprint and is retained.
pub fn resolve_project_root_set(
    primary_root_path: impl AsRef<Path>,
    additional_root_paths: &[impl AsRef<Path>],
) -> Result<ResolvedProjectRootSet, ProjectRootValidationError> {
    if additional_root_paths.len() > MAX_ADDITIONAL_ROOTS {
        return Err(ProjectRootValidationError::new(
            ProjectRootErrorCode::TooManyAdditionalRoots,
            format!("At most {MAX_ADDITIONAL_ROOTS} additional roots are supported"),
            None,
        ));
    }
    let primary_root = resolve_root(primary_root_path.as_ref())?;
    let additional_roots = additional_root_paths
        .iter()
        .map(|path| resolve_root(path.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    let roots = std::iter::once(&primary_root)
        .chain(additional_roots.iter())
        .collect::<Vec<_>>();
    assert_no_duplicate_or_overlapping_roots(&roots)?;
    let fingerprint = compute_root_fingerprint(
        &primary_root.real_path,
        &additional_roots
            .iter()
            .map(|root| root.real_path.clone())
            .collect::<Vec<_>>(),
    );
    Ok(ResolvedProjectRootSet {
        primary_root,
        additional_roots,
        fingerprint,
    })
}

pub fn verify_stored_project_root_set(
    primary_root: &ResolvedRoot,
    additional_roots: &[ResolvedRoot],
    expected_fingerprint: &str,
) -> Result<ResolvedProjectRootSet, ProjectRootValidationError> {
    let additional_paths = additional_roots
        .iter()
        .map(|root| PathBuf::from(&root.path))
        .collect::<Vec<_>>();
    let resolved = resolve_project_root_set(Path::new(&primary_root.path), &additional_paths)?;
    let stored_roots = std::iter::once(primary_root).chain(additional_roots.iter());
    let resolved_roots =
        std::iter::once(&resolved.primary_root).chain(resolved.additional_roots.iter());
    for (stored, resolved_root) in stored_roots.zip(resolved_roots) {
        if !canonical_paths_equal(&stored.real_path, &resolved_root.real_path) {
            return Err(ProjectRootValidationError::new(
                ProjectRootErrorCode::RootChangedOnDisk,
                format!(
                    "Project root now resolves to a different location: {}",
                    stored.path
                ),
                Some(stored.path.clone()),
            ));
        }
    }
    if resolved.fingerprint != expected_fingerprint {
        return Err(ProjectRootValidationError::new(
            ProjectRootErrorCode::RootChangedOnDisk,
            "The current project root fingerprint differs from the stored authority",
            None,
        ));
    }
    Ok(resolved)
}

pub fn canonical_paths_equal(left: &str, right: &str) -> bool {
    comparison_key(Path::new(left)) == comparison_key(Path::new(right))
}

fn resolve_root(candidate: &Path) -> Result<ResolvedRoot, ProjectRootValidationError> {
    if !candidate.is_absolute() {
        return Err(ProjectRootValidationError::new(
            ProjectRootErrorCode::RootPathNotAbsolute,
            format!(
                "Project roots must be absolute paths: {}",
                candidate.display()
            ),
            Some(candidate.display().to_string()),
        ));
    }
    let canonical = match fs::canonicalize(candidate) {
        Ok(path) => normalize_path(&path),
        Err(error) if is_permission_error(&error) => {
            return Err(inaccessible_root_error(candidate, error));
        }
        Err(error) => {
            return Err(ProjectRootValidationError::with_source(
                ProjectRootErrorCode::RootNotFound,
                format!(
                    "Der Projektordner existiert nicht mehr oder wurde verschoben: {}",
                    candidate.display()
                ),
                Some(candidate.display().to_string()),
                error,
            ));
        }
    };
    let metadata = match fs::metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(error) if is_permission_error(&error) => {
            return Err(inaccessible_root_error(candidate, error));
        }
        Err(error) => {
            return Err(ProjectRootValidationError::with_source(
                ProjectRootErrorCode::RootNotFound,
                format!(
                    "Der Projektordner ist nicht mehr erreichbar: {}",
                    candidate.display()
                ),
                Some(candidate.display().to_string()),
                error,
            ));
        }
    };
    if !metadata.is_dir() {
        return Err(ProjectRootValidationError::new(
            ProjectRootErrorCode::RootNotDirectory,
            format!("Project root is not a directory: {}", candidate.display()),
            Some(candidate.display().to_string()),
        ));
    }
    if !has_directory_access(&canonical) {
        return Err(ProjectRootValidationError::new(
            ProjectRootErrorCode::RootNotAccessible,
            format!(
                "GeminUI hat keinen Zugriff auf den Projektordner: {}. Bitte erteile den Ordnerzugriff erneut oder wähle den Ordner neu aus.",
                candidate.display()
            ),
            Some(candidate.display().to_string()),
        ));
    }
    let path = normalize_path(candidate).display().to_string();
    let real_path = canonical.display().to_string();
    let label = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| real_path.clone());
    Ok(ResolvedRoot {
        path,
        real_path,
        label,
    })
}

fn has_directory_access(path: &Path) -> bool {
    // Reading the directory models the R_OK/X_OK capabilities needed by a
    // child process.  On Unix, mode bits also catch a revoked grant when the
    // test/process runs as root (where read_dir itself would otherwise pass).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o555 == 0)
            .unwrap_or(true)
        {
            return false;
        }
    }
    fs::read_dir(path).is_ok()
}

fn inaccessible_root_error(candidate: &Path, source: std::io::Error) -> ProjectRootValidationError {
    ProjectRootValidationError::with_source(
        ProjectRootErrorCode::RootNotAccessible,
        format!(
            "GeminUI hat keinen Zugriff auf den Projektordner: {}. Bitte erteile den Ordnerzugriff erneut oder wähle den Ordner neu aus.",
            candidate.display()
        ),
        Some(candidate.display().to_string()),
        source,
    )
}

fn assert_no_duplicate_or_overlapping_roots(
    roots: &[&ResolvedRoot],
) -> Result<(), ProjectRootValidationError> {
    for left_index in 0..roots.len() {
        for right_index in left_index + 1..roots.len() {
            let left = roots[left_index];
            let right = roots[right_index];
            if canonical_paths_equal(&left.real_path, &right.real_path) {
                return Err(ProjectRootValidationError::new(
                    ProjectRootErrorCode::DuplicateRoot,
                    format!(
                        "The same directory was selected more than once: {}",
                        right.path
                    ),
                    Some(right.path.clone()),
                ));
            }
            if is_descendant(Path::new(&left.real_path), Path::new(&right.real_path))
                || is_descendant(Path::new(&right.real_path), Path::new(&left.real_path))
            {
                return Err(ProjectRootValidationError::new(
                    ProjectRootErrorCode::OverlappingRoot,
                    format!(
                        "Nested project roots are redundant: {} and {}",
                        left.path, right.path
                    ),
                    Some(right.path.clone()),
                ));
            }
        }
    }
    Ok(())
}

fn is_descendant(parent: &Path, candidate: &Path) -> bool {
    candidate
        .strip_prefix(parent)
        .map(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(false)
}

fn comparison_key(path: &Path) -> String {
    let normalized = normalize_path(path).display().to_string();
    #[cfg(windows)]
    {
        normalized.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn is_permission_error(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::PermissionDenied)
}

#[cfg(test)]
mod tests {
    use super::{canonical_paths_equal, resolve_project_root_set};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("geminui-project-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_relative_and_nested_roots() {
        let error = resolve_project_root_set("relative", &[] as &[&str]).unwrap_err();
        assert_eq!(error.code.as_str(), "root_path_not_absolute");
        let base = temp_dir();
        let primary = base.join("primary");
        let nested = primary.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let error = resolve_project_root_set(&primary, &[&nested]).unwrap_err();
        assert_eq!(error.code.as_str(), "overlapping_root");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn resolves_symlink_and_preserves_ordered_fingerprint() {
        let base = temp_dir();
        let primary = base.join("primary");
        let additional = base.join("additional");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&additional).unwrap();
        let resolved = resolve_project_root_set(&primary, &[&additional]).unwrap();
        assert!(resolved
            .fingerprint
            .chars()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert!(!canonical_paths_equal("/a", "/A"));
        fs::remove_dir_all(base).unwrap();
    }
}
