pub mod plugin;
pub mod service;
pub use plugin::{
    app_check_for_updates, app_download_update, app_install_update, init as updater_plugin,
    DownloadUpdateInput, InstallUpdateInput, VoidResult,
};
pub use service::{AppUpdateDownloadProgress, AppUpdateInfo, DownloadUpdateResult};
